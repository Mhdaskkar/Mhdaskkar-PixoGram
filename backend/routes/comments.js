/**
 * Comments Router
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { body, param, query, validationResult } = require('express-validator');

const router = express.Router();
const { requireAuth, optionalAuth, attachUserInfo } = require('../middleware/auth');
const cosmos = require('../services/cosmos');
const redis  = require('../services/redis');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// GET /v1/photos/:photoId/comments
router.get('/:photoId/comments',
  [
    param('photoId').isUUID(),
    query('page').optional().isInt({ min:1 }).toInt(),
    query('limit').optional().isInt({ min:1, max:50 }).toInt(),
  ],
  validate,
  optionalAuth, attachUserInfo,
  async (req, res, next) => {
    try {
      const { photoId } = req.params;
      const { page=1, limit=20 } = req.query;
      const offset = (page-1)*limit;

      const cacheKey = `comments:${photoId}:${page}:${limit}`;
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));

      const { resources: comments } = await cosmos.container('Comments').items.query({
        query: `SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC OFFSET ${offset} LIMIT ${limit}`,
        parameters: [{ name:'@photoId', value: photoId }],
      }).fetchAll();

      const result = { comments, photoId, page, limit };
      await redis.setex(cacheKey, 60, JSON.stringify(result));
      res.json(result);
    } catch (err) { next(err); }
  }
);

// POST /v1/photos/:photoId/comments
router.post('/:photoId/comments',
  requireAuth, attachUserInfo,
  [
    param('photoId').isUUID(),
    body('text').trim().notEmpty().isLength({ min:1, max:500 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { photoId } = req.params;
      const { text } = req.body;

      const { resource: photo } = await cosmos.container('Photos').item(photoId, photoId).read();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      const comment = {
        id:          randomUUID(),
        photoId,
        userId:      req.user.id,
        userName:    req.user.displayName,
        text,
        createdAt:   new Date().toISOString(),
      };

      await cosmos.container('Comments').items.create(comment);

      photo.commentCount = (photo.commentCount || 0) + 1;
      photo.updatedAt = new Date().toISOString();
      await cosmos.container('Photos').item(photoId, photoId).replace(photo);

      await redis.deletePattern(`comments:${photoId}:*`);
      await redis.del(`photo:${photoId}`);

      res.status(201).json(comment);
    } catch (err) { next(err); }
  }
);

// DELETE /v1/comments/:id
router.delete('/comments/:id',
  requireAuth, attachUserInfo,
  [param('id').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const { resources } = await cosmos.container('Comments').items.query({
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name:'@id', value: id }],
      }).fetchAll();

      const comment = resources[0];
      if (!comment) return res.status(404).json({ error: 'Comment not found' });
      if (comment.userId !== req.user.id) return res.status(403).json({ error: 'Not your comment' });

      await cosmos.container('Comments').item(id, comment.photoId).delete();

      try {
        const { resource: photo } = await cosmos.container('Photos').item(comment.photoId, comment.photoId).read();
        if (photo) {
          photo.commentCount = Math.max(0, (photo.commentCount || 1) - 1);
          photo.updatedAt = new Date().toISOString();
          await cosmos.container('Photos').item(comment.photoId, comment.photoId).replace(photo);
          await redis.del(`photo:${comment.photoId}`);
        }
      } catch { /* non-critical */ }

      await redis.deletePattern(`comments:${comment.photoId}:*`);
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;