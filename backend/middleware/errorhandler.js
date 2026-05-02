/**
 * Global Error Handler and Request Logger middleware
 */

function errorHandler(err, req, res, next) {
  // JWT errors
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Invalid or expired token', details: err.message });
  }
  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum 20MB allowed.' });
  }
  if (err.message?.includes('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }
  // Cosmos 404
  if (err.code === 404) {
    return res.status(404).json({ error: 'Resource not found' });
  }
  // Cosmos conflict (duplicate id)
  if (err.code === 409) {
    return res.status(409).json({ error: 'Resource already exists' });
  }
  // CORS
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS: origin not allowed' });
  }

  // Log unexpected errors
  console.error('[ERROR]', {
    path:    req.path,
    method:  req.method,
    message: err.message,
    stack:   process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'An internal error occurred'
    : err.message;

  res.status(status).json({ error: message });
}

function requestLogger(req, res, next) {
  req.requestId = require('uuid').v4();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

module.exports = { errorHandler, requestLogger };