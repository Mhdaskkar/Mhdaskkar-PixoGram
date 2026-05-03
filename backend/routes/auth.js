const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { randomUUID } = require('crypto');
const { body, validationResult } = require('express-validator');
const { requireAuth, attachUserInfo, signToken } = require('../middleware/auth');
const cosmos = require('../services/cosmos');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('displayName').optional().isLength({ min: 1, max: 100 }).trim(),
  body('role').optional().isIn(['consumer', 'creator']),
  validate,
  async (req, res, next) => {
    try {
      const { email, password, displayName, role = 'consumer' } = req.body;
      const { resources } = await cosmos.container('Users').items
        .query({ query: 'SELECT * FROM c WHERE c.email = @email', parameters: [{ name: '@email', value: email }] })
        .fetchAll();
      if (resources.length > 0) return res.status(409).json({ error: 'Email already registered.' });
      const passwordHash = await bcrypt.hash(password, 12);
      const userId = randomUUID();
      const now = new Date().toISOString();
      const newUser = { id: userId, email, passwordHash, displayName: displayName || email.split('@')[0], role, createdAt: now, updatedAt: now };
      await cosmos.container('Users').items.create(newUser);
      const token = signToken({ sub: userId, email, displayName: newUser.displayName, role });
      res.status(201).json({ message: 'Account created.', token, user: { id: userId, email, displayName: newUser.displayName, role } });
    } catch (err) { next(err); }
  }
);

router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const { resources } = await cosmos.container('Users').items
        .query({ query: 'SELECT * FROM c WHERE c.email = @email', parameters: [{ name: '@email', value: email }] })
        .fetchAll();
      if (resources.length === 0) return res.status(401).json({ error: 'Invalid email or password.' });
      const user = resources[0];
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });
      const token = signToken({ sub: user.id, email: user.email, displayName: user.displayName, role: user.role });
      res.json({ token, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } });
    } catch (err) { next(err); }
  }
);

router.post('/refresh', requireAuth, attachUserInfo, (req, res) => {
  const { id, email, displayName, role } = req.user;
  const token = signToken({ sub: id, email, displayName, role });
  res.json({ token });
});

router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out. Discard your token on the client.' });
});

router.get('/profile', requireAuth, attachUserInfo, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

module.exports = router;