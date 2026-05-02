const { webcrypto } = require('crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Deploy: 2026-05-03 00:09:50
/**
 * PixoGram API â€” Express Server Entry Point
 * Azure Cloud-Native Photo Sharing Platform
 */

require('dotenv').config();


const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');

// â”€â”€ ROUTES â”€â”€
const photosRouter   = require('./routes/photos');
const commentsRouter = require('./routes/comments');
const ratingsRouter  = require('./routes/ratings');
const usersRouter    = require('./routes/users');
const authRouter     = require('./routes/auth');

// â”€â”€ MIDDLEWARE (FIXED: ONLY ONE IMPORT SOURCE) â”€â”€
const { errorHandler, requestLogger } = require('./middleware/errorhandler');

const app  = express();
const PORT = process.env.PORT || 3000;

// â”€â”€ TRUST PROXY (Azure App Service) â”€â”€
app.set('trust proxy', 1);

// â”€â”€ SECURITY â”€â”€
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// â”€â”€ CORS â”€â”€
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',');

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
  credentials: true,
}));

// â”€â”€ RATE LIMITING â”€â”€
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use(globalLimiter);

// â”€â”€ BODY PARSING â”€â”€
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// â”€â”€ LOGGING â”€â”€
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// âœ” FIXED: only ONE requestLogger (no duplicate import)
app.use(requestLogger);

// â”€â”€ HEALTH CHECK â”€â”€
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV,
  });
});

// â”€â”€ DEEP HEALTH CHECK â”€â”€
app.get('/health/deep', async (req, res) => {
  const checks = { api: 'ok', cosmos: 'unknown', redis: 'unknown', blob: 'unknown' };

  try {
    const { cosmosClient } = require('./services/cosmos');
    await cosmosClient.getDatabaseAccount();
    checks.cosmos = 'ok';
  } catch {
    checks.cosmos = 'error';
  }

  try {
    const redis = require('./services/redis');
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
  }

  const allOk = Object.values(checks).every(v => v === 'ok');

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    checks
  });
});

// â”€â”€ DEBUG LOG (optional) â”€â”€
console.log({
  authRouter,
  usersRouter,
  photosRouter,
  commentsRouter,
  ratingsRouter
});

// â”€â”€ API ROUTES â”€â”€
app.use('/v1/auth',     authRouter);
app.use('/v1/users',    usersRouter);
app.use('/v1/photos',   photosRouter);
app.use('/v1/photos',   commentsRouter);
app.use('/v1/photos',   ratingsRouter);
app.use('/v1/comments', commentsRouter);

// â”€â”€ 404 HANDLER â”€â”€
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// â”€â”€ GLOBAL ERROR HANDLER â”€â”€
app.use(errorHandler);

// â”€â”€ START SERVER â”€â”€
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PixoGram API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

module.exports = app;






