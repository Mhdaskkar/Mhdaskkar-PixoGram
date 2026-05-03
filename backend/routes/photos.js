/** photo
 * Photos Router
 * GET    /v1/photos          â€” list/search (public)
 * GET    /v1/photos/:id      â€” single photo (public)
 * POST   /v1/photos          â€” upload (creator only)
 * PATCH  /v1/photos/:id      â€” update metadata (creator, owner)
 * DELETE /v1/photos/:id      â€” delete (creator, owner)
 */
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
const { generateThumbnail } = require('../utils/thumbnail');

// â”€â”€ MULTER (in-memory storage, then stream to Azure Blob) â”€â”€
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. JPEG, PNG, and WEBP only.'));
  },
});

// Upload-specific rate limiter
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: 'Upload limit (20/hour) reached.' },
});

// â”€â”€ HELPERS â”€â”€
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const CACHE_TTL = {
  feed:   300,  // 5 min
  search: 120,  // 2 min
  photo:  600,  // 10 min
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /v1/photos â€” list / search
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // Build cache key
      const cacheKey = `feed:${JSON.stringify({ q, location, tags, creatorId, minRating, sort, page, limit })}`;

      // Try Redis cache
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      // Query Cosmos DB
      const offset = (page - 1) * limit;
      let querySpec = buildSearchQuery({ q, location, tags, creatorId, minRating, sort, offset, limit });

      const { resources: photos, hasMoreResults } = await cosmos.containers.photos
        .items.query(querySpec, { maxItemCount: limit })
        .fetchNext();

      // Total count (lightweight query)
      const countSpec = buildCountQuery({ q, location, tags, creatorId, minRating });
      const { resources: [countResult] } = await cosmos.containers.photos
        .items.query(countSpec).fetchAll();
      const total = countResult?.count || 0;

      const result = {
        photos,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };

      // Cache result
      const ttl = q ? CACHE_TTL.search : CACHE_TTL.feed;
      await redis.setex(cacheKey, ttl, JSON.stringify(result));

      res.json(result);
    } //catch (err) {
      //next(err);
    //}
    catch (err) {
  console.error("FULL ERROR:", err);
  res.status(500).json({
    error: err.message,
    stack: err.stack
  });
}
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /v1/photos/:id â€” single photo
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/:id',
  [param('id').isUUID()], validate,
  optionalAuth, attachUserInfo,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const cacheKey = `photo:${id}`;

      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      const { resource: photo } = await cosmos.containers.photos.item(id, id).read();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      await redis.setex(cacheKey, CACHE_TTL.photo, JSON.stringify(photo));
      res.json(photo);
    } catch (err) {
      next(err);
    }
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /v1/photos â€” upload photo (creator only)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      console.log('[photos] POST received');
      console.log('[photos] req.file:', req.file ? req.file.originalname : 'MISSING');
      console.log('[photos] buffer:', req.file?.buffer ? req.file.buffer.length + ' bytes' : 'UNDEFINED');
      console.log('[photos] body:', req.body);

      if (!req.file) return res.status(400).json({ error: 'Image file required' });
      if (!req.file.buffer) return res.status(400).json({ error: 'File buffer is empty' });

      const photoId = randomUUID();
      const { title, caption='', location='', tags='', peoplePresent='' } = req.body;

      const tagList = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      const people  = typeof peoplePresent === 'string'
        ? peoplePresent.split(',').map(p => p.trim()).filter(Boolean)
        : (Array.isArray(peoplePresent) ? peoplePresent : []);

      // 1. Upload original to Azure Blob
      const blobName   = `originals/${photoId}${getExt(req.file.mimetype)}`;
      const blobUrl    = await blob.uploadBuffer(blobName, req.file.buffer, req.file.mimetype);

    // 2. Use original as thumbnail (skip Sharp for now)
      const thumbName = `thumbnails/${photoId}.jpg`;
      const thumbUrl  = await blob.uploadBuffer(thumbName, req.file.buffer, req.file.mimetype);

      // 3. Azure Cognitive Services â€” content moderation + auto-tags
      let aiTags = [];
      let moderationPassed = true;
      try {
        const visionResult = await vision.analyzeImage(blobUrl);
        aiTags = visionResult.tags || [];
        moderationPassed = !visionResult.adult?.isAdultContent && !visionResult.adult?.isRacyContent;
      } catch (visionErr) {
        console.warn('Vision API failed, skipping:', visionErr.message);
      }

      if (!moderationPassed) {
        // Delete uploaded blobs
        await blob.deleteBlob(blobName);
        await blob.deleteBlob(thumbName);
        return res.status(422).json({ error: 'Content moderation check failed. This image violates our community guidelines.' });
      }

      // Merge user tags with AI-detected tags (deduplicated)
      const allTags = [...new Set([...tagList, ...aiTags.map(t => t.name)])].slice(0, 20);

      // 4. Save to Cosmos DB
      const photoDoc = {
        id: photoId,
        creatorId:   req.user.id,
        creatorName: req.user.displayName,
        title,
        caption,
        location,
        peoplePresent: people,
        tags: allTags,
        blobUrl,
        thumbUrl,
        contentModerationPassed: true,
        averageRating: 0,
        ratingCount: 0,
        commentCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await cosmos.containers.photos.items.create(photoDoc);

      // 5. Invalidate feed cache
      await redis.deletePattern('feed:*');

      res.status(201).json(photoDoc);
    } catch (err) {
      next(err);
    }
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PATCH /v1/photos/:id â€” update metadata
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      const { resource: photo } = await cosmos.containers.photos.item(id, id).read();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });
      if (photo.creatorId !== req.user.id) return res.status(403).json({ error: 'Not the owner of this photo' });

      const allowedFields = ['title','caption','location','tags','peoplePresent'];
      allowedFields.forEach(field => {
        if (req.body[field] !== undefined) photo[field] = req.body[field];
      });
      photo.updatedAt = new Date().toISOString();

      const { resource: updated } = await cosmos.containers.photos.item(id, id).replace(photo);

      // Invalidate caches
      await redis.del(`photo:${id}`);
      await redis.deletePattern('feed:*');

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DELETE /v1/photos/:id
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/:id',
  requireAuth, attachUserInfo, isCreator,
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { resource: photo } = await cosmos.containers.photos.item(id, id).read();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });
      if (photo.creatorId !== req.user.id) return res.status(403).json({ error: 'Not the owner' });

      // Delete blobs
      const blobName  = photo.blobUrl.split('/').slice(-2).join('/');
      const thumbName = photo.thumbUrl.split('/').slice(-2).join('/');
      await Promise.allSettled([
        blob.deleteBlob(blobName),
        blob.deleteBlob(thumbName),
      ]);

      // Delete Cosmos document
      await cosmos.containers.photos.item(id, id).delete();

      // Cascade delete: comments + ratings
      await cosmos.deleteByPhotoId('comments', id);
      await cosmos.deleteByPhotoId('ratings', id);

      // Invalidate caches
      await redis.del(`photo:${id}`);
      await redis.deletePattern('feed:*');

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// â”€â”€ HELPERS â”€â”€
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

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
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

module.exports = router;
