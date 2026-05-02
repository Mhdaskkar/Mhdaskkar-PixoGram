/**
 * Ratings Router
 * POST /v1/photos/:photoId/ratings     — submit or update rating (consumer/creator)
 * GET  /v1/photos/:photoId/ratings/me  — get own rating for photo
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');

const router = express.Router();
const { requireAuth, attachUserInfo } = require('../middleware/auth');
const cosmos = require('../services/cosmos');
const redis  = require('../services/redis');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// POST /v1/photos/:photoId/ratings
router.post('/:photoId/ratings',
  requireAuth, attachUserInfo,
  [
    param('photoId').isUUID(),
    body('value').isInt({ min:1, max:5 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { photoId } = req.params;
      const { value } = req.body;
      const userId = req.user.id;
      const ratingId = `${userId}_${photoId}`;

      const { resource: photo } = await cosmos.containers.photos.item(photoId, photoId).read();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      // Check existing rating
      let existing;
      try {
        const { resource } = await cosmos.containers.ratings.item(ratingId, photoId).read();
        existing = resource;
      } catch { existing = null; }

      const now = new Date().toISOString();

      if (existing) {
        // Update existing: recalculate average
        const oldValue = existing.value;
        const totalBefore = photo.averageRating * photo.ratingCount;
        photo.averageRating = (totalBefore - oldValue + value) / photo.ratingCount;

        existing.value = value;
        existing.updatedAt = now;
        await cosmos.containers.ratings.item(ratingId, photoId).replace(existing);
      } else {
        // New rating
        const totalBefore = photo.averageRating * photo.ratingCount;
        photo.ratingCount += 1;
        photo.averageRating = (totalBefore + value) / photo.ratingCount;

        await cosmos.containers.ratings.items.create({
          id: ratingId, photoId, userId, value, createdAt: now, updatedAt: now,
        });
      }

      photo.averageRating = Math.round(photo.averageRating * 10) / 10;
      photo.updatedAt = now;
      await cosmos.containers.photos.item(photoId, photoId).replace(photo);

      await redis.del(`photo:${photoId}`);
      await redis.deletePattern('feed:*');

      res.json({
        photoId, userId, value,
        newAverage: photo.averageRating,
        ratingCount: photo.ratingCount,
      });
    } catch (err) { next(err); }
  }
);

// GET /v1/photos/:photoId/ratings/me
router.get('/:photoId/ratings/me',
  requireAuth, attachUserInfo,
  [param('photoId').isUUID()], validate,
  async (req, res, next) => {
    try {
      const { photoId } = req.params;
      const ratingId = `${req.user.id}_${photoId}`;
      try {
        const { resource } = await cosmos.containers.ratings.item(ratingId, photoId).read();
        res.json({ rated: true, value: resource.value });
      } catch {
        res.json({ rated: false, value: null });
      }
    } catch (err) { next(err); }
  }
);

module.exports = router;