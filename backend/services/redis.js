/**
 * Azure Cache for Redis Service
 */
const Redis = require('ioredis');

const REDIS_HOST     = process.env.REDIS_HOST     || 'localhost';
const REDIS_PORT     = process.env.REDIS_PORT     || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;
const IS_PROD        = process.env.NODE_ENV === 'production';

let _client;

function getClient() {
  if (!_client) {
    _client = new Redis({
      host:     REDIS_HOST,
      port:     parseInt(REDIS_PORT),
      password: REDIS_PASSWORD,
      tls:      IS_PROD ? {} : undefined,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 200, 1000);
      },
      lazyConnect:        true,
      enableOfflineQueue: false,
    });

    _client.on('error', (err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Redis error (non-fatal):', err.message);
      }
    });

    console.log('[redis] Connecting to:', REDIS_HOST + ':' + REDIS_PORT);
  }
  return _client;
}

async function get(key) {
  try { return await getClient().get(key); }
  catch { return null; }
}

async function set(key, value, exFlag, ttl) {
  try {
    if (exFlag === 'EX' && ttl) {
      await getClient().setex(key, ttl, value);
    } else {
      await getClient().set(key, value);
    }
  } catch { /* non-fatal */ }
}

async function setex(key, ttl, value) {
  try { await getClient().setex(key, ttl, value); }
  catch { /* non-fatal */ }
}

async function del(key) {
  try { await getClient().del(key); }
  catch { /* non-fatal */ }
}

async function ping() {
  return getClient().ping();
}

async function deletePattern(pattern) {
  try {
    const client = getClient();
    let cursor = '0';
    do {
      const [newCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = newCursor;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== '0');
  } catch { /* non-fatal */ }
}

module.exports = { get, set, setex, del, ping, deletePattern, getClient };