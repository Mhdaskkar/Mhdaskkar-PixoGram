const express  = require('express');
const multer   = require('multer');
const { randomUUID } = require('crypto');
const { body, query, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const { requireAuth, optionalAuth, isCreator, attachUserInfo } = require('../middleware/auth');
const cosmos  = require('../services/cosmos');
const blob    = require('../services/blob');
const redis   = require('../services/redis');
const vision  = require('../services/vision');

const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. JPEG, PNG, and WEBP only.'));
  },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Upload limit (20/hour) reached.' },
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const CACHE_TTL = { feed: 300, search: 120, photo: 600 };

// helper — find photo by id using query (partition key is creatorId)
async function findPhotoById(id) {
  const { resources } = await cosmos.container('Photos').items
    .query({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  return resources[0] || null;
}

// ── GET /v1/photos ──────────────────────────────────────────────────────────
router.get('/',
  optionalAuth, attachUserInfo,
  [
    query('q').optional().trim().isLength({ max: 100 }),
    query('location').optional().trim().isLength({ max: 100 }),
    query('tags').optional().trim(),
    query('creatorId').optional().isUUID(),
    query('minRating').optional().isFloat({ min: 0, max: 5 }),
    query('sort').optional().isIn(['recent','rating','comments']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { q, location, tags, creatorId, minRating, sort='recent', page=1, limit=20 } = req.query;
      const cacheKey = `feed:${JSON.stringify({ q, location, tags, creatorId, minRating, sort, page, limit })}`;

      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      const offset = (page - 1) * limit;
      const querySpec = buildSearchQuery({ q, location, tags, creatorId, minRating, sort, offset, limit });

      const { resources: photos } = await cosmos.container('Photos')
        .items.query(querySpec, { maxItemCount: limit })
        .fetchNext();

      const countSpec = buildCountQuery({ q, location, tags, creatorId, minRating });
      const { resources: [countResult] } = await cosmos.container('Photos')
        .items.query(countSpec).fetchAll();
      const total = countResult?.count || 0;

      const result = {
        photos,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };

      const ttl = q ? CACHE_TTL.search : CACHE_TTL.feed;
      await redis.setex(cacheKey, ttl, JSON.stringify(result));

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /v1/photos/:id ──────────────────────────────────────────────────────
router.get('/:id',
  [param('id').isUUID()], validate,
  optionalAuth, attachUserInfo,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const cacheKey = `photo:${id}`;

      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      const photo = await findPhotoById(id);
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      await redis.setex(cacheKey, CACHE_TTL.photo, JSON.stringify(photo));
      res.json(photo);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /v1/photos ─────────────────────────────────────────────────────────
router.post('/',
  requireAuth, attachUserInfo, isCreator,
  uploadLimiter,
  upload.single('image'),
  [
    body('title').trim().notEmpty().isLength({ max: 120 }),
    body('caption').optional().trim().isLength({ max: 500 }),
    body('location').optional().trim().isLength({ max: 100 }),
    body('tags').optional().trim(),
    body('peoplePresent').optional(),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Image file required' });
      if (!req.file.buffer) return res.status(400).json({ error: 'File buffer is empty' });

      const photoId = randomUUID();
      const { title, caption='', location='', tags='', peoplePresent='' } = req.body;

      const tagList = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      const people  = typeof peoplePresent === 'string'
        ? peoplePresent.split(',').map(p => p.trim()).filter(Boolean)
        : (Array.isArray(peoplePresent) ? peoplePresent : []);

      const blobName = `originals/${photoId}${getExt(req.file.mimetype)}`;
      const blobUrl  = await blob.uploadBuffer(blobName, req.file.buffer, req.file.mimetype);

      const thumbName = `thumbnails/${photoId}${getExt(req.file.mimetype)}`;
      const thumbUrl  = await blob.uploadBuffer(thumbName, req.file.buffer, req.file.mimetype);

     // 3. Vision API (optional)
      let aiTags = [];
      let autoDescription = '';
      try {
        const visionResult = await vision.analyzeImage(blobUrl);
        aiTags = visionResult.tags || [];
        autoDescription = visionResult.description || '';
        console.log('[vision] Description:', autoDescription);
        console.log('[vision] Tags:', aiTags.map(t => t.name));
        const moderationPassed = !visionResult.adult?.isAdultContent && !visionResult.adult?.isRacyContent;
        if (!moderationPassed) {
          await blob.deleteBlob(blobName);
          await blob.deleteBlob(thumbName);
          return res.status(422).json({ error: 'Content moderation check failed.' });
        }
      } catch (visionErr) {
        console.warn('Vision API failed, skipping:', visionErr.message);
      }

      const allTags = [...new Set([...tagList, ...aiTags.map(t => t.name)])].slice(0, 20);

     const photoDoc = {
        id:          photoId,
        creatorId:   req.user.id,
        creatorName: req.user.displayName,
        title,
        caption:     caption || autoDescription,
        autoDescription,
        location,
        peoplePresent: people,
        tags: allTags,
        blobUrl,
        thumbUrl,
        contentModerationPassed: true,
        averageRating: 0,
        ratingCount:   0,
        commentCount:  0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await cosmos.container('Photos').items.create(photoDoc);
      await redis.deletePattern('feed:*');

      res.status(201).json(photoDoc);
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /v1/photos/:id ────────────────────────────────────────────────────
router.patch('/:id',
  requireAuth, attachUserInfo, isCreator,
  [
    param('id').isUUID(),
    body('title').optional().trim().isLength({ max: 120 }),
    body('caption').optional().trim().isLength({ max: 500 }),
    body('location').optional().trim().isLength({ max: 100 }),
    body('tags').optional().isArray(),
    body('peoplePresent').optional().isArray(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const photo = await findPhotoById(id);
      if (!photo) return res.status(404).json({ error: 'Photo not found' });
      if (photo.creatorId !== req.user.id) return res.status(403).json({ error: 'Not the owner of this photo' });

      const allowedFields = ['title','caption','location','tags','peoplePresent'];
      allowedFields.forEach(field => {
        if (req.body[field] !== undefined) photo[field] = req.body[field];
      });
      photo.updatedAt = new Date().toISOString();

      const { resource: updated } = await cosmos.container('Photos').item(id, photo.creatorId).replace(photo);

      await redis.del(`photo:${id}`);
      await redis.deletePattern('feed:*');

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /v1/photos/:id ───────────────────────────────────────────────────
router.delete('/:id',
  requireAuth, attachUserInfo, isCreator,
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const photo = await findPhotoById(id);
      if (!photo) return res.status(404).json({ error: 'Photo not found' });
      if (photo.creatorId !== req.user.id) return res.status(403).json({ error: 'Not the owner' });

      const blobName  = photo.blobUrl.split('/').slice(-2).join('/');
      const thumbName = photo.thumbUrl.split('/').slice(-2).join('/');
      await Promise.allSettled([
        blob.deleteBlob(blobName),
        blob.deleteBlob(thumbName),
      ]);

      await cosmos.container('Photos').item(id, photo.creatorId).delete();
      await cosmos.deleteByPhotoId('Comments', id);
      await cosmos.deleteByPhotoId('Ratings', id);

      await redis.del(`photo:${id}`);
      await redis.deletePattern('feed:*');

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getExt(mimetype) {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mimetype] || '.jpg';
}

function buildSearchQuery({ q, location, tags, creatorId, minRating, sort, offset, limit }) {
  let conditions = ['c.contentModerationPassed = true'];
  const params   = [];

  if (q) {
    conditions.push('(CONTAINS(LOWER(c.title), @q) OR CONTAINS(LOWER(c.caption), @q))');
    params.push({ name: '@q', value: q.toLowerCase() });
  }
  if (location) {
    conditions.push('CONTAINS(LOWER(c.location), @location)');
    params.push({ name: '@location', value: location.toLowerCase() });
  }
  if (tags) {
    const tagList = tags.split(',').map(t=>t.trim().toLowerCase());
    tagList.forEach((tag, i) => {
      conditions.push(`ARRAY_CONTAINS(c.tags, @tag${i})`);
      params.push({ name: `@tag${i}`, value: tag });
    });
  }
  if (creatorId) {
    conditions.push('c.creatorId = @creatorId');
    params.push({ name: '@creatorId', value: creatorId });
  }
  if (minRating) {
    conditions.push('c.averageRating >= @minRating');
    params.push({ name: '@minRating', value: parseFloat(minRating) });
  }

  const orderMap = { recent: 'c.createdAt DESC', rating: 'c.averageRating DESC', comments: 'c.commentCount DESC' };
  const orderBy  = orderMap[sort] || orderMap.recent;
  const where    = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  return {
    query: `SELECT * FROM c ${where} ORDER BY ${orderBy} OFFSET ${offset} LIMIT ${limit}`,
    parameters: params,
  };
}

function buildCountQuery({ q, location, tags, creatorId, minRating }) {
  const { query: baseQ, parameters } = buildSearchQuery({ q, location, tags, creatorId, minRating, sort:'recent', offset:0, limit:0 });
  const countQ = baseQ.replace(/SELECT \*/, 'SELECT VALUE COUNT(1)').replace(/ORDER BY .* OFFSET .* LIMIT .*/, '');
  return { query: countQ, parameters };
}

module.exports = router;// redeploy 05/03/2026 12:09:25
