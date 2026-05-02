/**
 * Users Routes
 * GET    /v1/users/:id          — get user profile
 * PATCH  /v1/users/:id          — update user profile (self only)
 * GET    /v1/users/:id/photos   — get user's photos
 * GET    /v1/users/:id/stats    — get user statistics
 */
const express = require('express');
const router = express.Router();
const { param, body, validationResult } = require('express-validator');

const { requireAuth, optionalAuth, attachUserInfo } = require('../middleware/auth');
const cosmos = require('../services/cosmos');
const redis = require('../services/redis');

/**
 * Validation helper
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

/**
 * GET /v1/users/:id
 * Retrieve user profile by ID (public)
 */
router.get('/:id',
  param('id').isUUID().trim(),
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      // Try Redis cache first
      const cached = await redis.get(`user:${id}`);
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      // Fetch from Cosmos
      const user = await cosmos.container('Users').item(id, id).read();
      if (!user.resource) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Cache for 1 hour
      await redis.set(`user:${id}`, JSON.stringify(user.resource), 'EX', 3600);

      res.json(user.resource);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /v1/users/:id
 * Update user profile (self only)
 */
router.patch('/:id',
  requireAuth,
  attachUserInfo,
  param('id').isUUID().trim(),
  body('displayName').optional().isLength({ min: 1, max: 100 }).trim(),
  body('bio').optional().isLength({ max: 500 }).trim(),
  body('website').optional().isURL(),
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      // Can only update own profile
      if (id !== userId) {
        return res.status(403).json({ error: 'Cannot update other user profiles' });
      }

      const updates = {
        displayName: req.body.displayName,
        bio: req.body.bio,
        website: req.body.website,
        updatedAt: new Date().toISOString(),
      };

      const user = await cosmos.container('Users').item(id, id).read();
      const updated = { ...user.resource, ...updates };

      await cosmos.container('Users').item(id, id).replace(updated);

      // Invalidate cache
      await redis.del(`user:${id}`);

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /v1/users/:id/photos
 * Get user's photos with pagination
 */
router.get('/:id/photos',
  param('id').isUUID().trim(),
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { limit = 20, offset = 0 } = req.query;

      // Check user exists
      const user = await cosmos.container('Users').item(id, id).read();
      if (!user.resource) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Query photos by creator
      const { resources } = await cosmos.container('Photos').items
        .query(`SELECT * FROM c WHERE c.creatorId = @id ORDER BY c.createdAt DESC OFFSET @offset LIMIT @limit`, {
          parameters: [
            { name: '@id', value: id },
            { name: '@offset', value: parseInt(offset) },
            { name: '@limit', value: parseInt(limit) + 1 },
          ],
        })
        .fetchAll();

      const hasMore = resources.length > limit;
      const photos = hasMore ? resources.slice(0, limit) : resources;

      res.json({ photos, hasMore, total: resources.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /v1/users/:id/stats
 * Get user statistics
 */
router.get('/:id/stats',
  param('id').isUUID().trim(),
  validate,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      // Try cache
      const cached = await redis.get(`user:stats:${id}`);
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      // Count photos
      const photosResult = await cosmos.container('Photos').items
        .query('SELECT COUNT(c.id) as count FROM c WHERE c.creatorId = @id', {
          parameters: [{ name: '@id', value: id }],
        })
        .fetchAll();

      const photoCount = photosResult.resources[0]?.count || 0;

      // Count comments
      const commentsResult = await cosmos.container('Comments').items
        .query('SELECT COUNT(c.id) as count FROM c WHERE c.userId = @id', {
          parameters: [{ name: '@id', value: id }],
        })
        .fetchAll();

      const commentCount = commentsResult.resources[0]?.count || 0;

      const stats = {
        userId: id,
        photoCount,
        commentCount,
        joinedAt: new Date().toISOString(),
      };

      // Cache for 1 hour
      await redis.set(`user:stats:${id}`, JSON.stringify(stats), 'EX', 3600);

      res.json(stats);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
