/**
 * Auth Middleware — Local JWT Authentication
 * Replaces Azure AD B2C with self-signed JWTs using jsonwebtoken
 */
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';

function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

const requireAuth = (req, res, next) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required. Provide a Bearer token.' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired. Please log in again.' });
    return res.status(401).json({ error: 'Invalid token.' });
  }
};

const optionalAuth = (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try { req.auth = jwt.verify(token, JWT_SECRET); } catch {}
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
  const userRole = req.auth.role || 'consumer';
  if (!roles.includes(userRole)) return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: userRole });
  next();
};

const isCreator = requireRole('creator');
const isConsumerOrCreator = requireRole('consumer', 'creator');

const attachUserInfo = (req, res, next) => {
  if (req.auth) {
    req.user = {
      id:          req.auth.sub,
      email:       req.auth.email,
      displayName: req.auth.displayName || req.auth.email,
      role:        req.auth.role || 'consumer',
    };
  }
  next();
};

const signToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });

module.exports = { requireAuth, optionalAuth, requireRole, isCreator, isConsumerOrCreator, attachUserInfo, signToken };
