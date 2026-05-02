/**
 * Azure Cache for Redis Service
 * Wraps ioredis with helper methods used across the API
 */
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let _client;

function getClient() {
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      tls: process.env.NODE_ENV === 'production' ? {} : undefined,
      password: process.env.REDIS_PASSWORD,
      retryStrategy: (times) => {
        if (times > 3) return null; // Stop retrying after 3 attempts
        return Math.min(times * 200, 1000);
      },
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    _client.on('error', (err) => {
      // Log but don't crash â€” app can function without cache (degraded)
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Redis error (non-fatal):', err.message);
      }
    });
  }
  return _client;
}

async function get(key) {
  try { return await getClient().get(key); }
  catch { return null; }
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

/**
 * Delete all keys matching a glob pattern (e.g. 'feed:*')
 * Uses SCAN to avoid blocking the server
 */
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

async function set(key, value, exFlag, ttl) {
  try {
    if (exFlag === 'EX' && ttl) {
      await getClient().setex(key, ttl, value);
    } else {
      await getClient().set(key, value);
    }
  } catch { /* non-fatal */ }
}
module.exports = { get, set, setex, del, ping, deletePattern, getClient };
