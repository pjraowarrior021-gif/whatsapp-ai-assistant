/**
 * Pluggable Storage Factory
 * Exports unified async storage interface supporting Memory (default) and Redis.
 */
import { config } from '../config.js';
import { privacyLog } from '../privacy.js';
import { MemoryStore } from './memory.js';
import { RedisStore } from './redis.js';

let activeStore = null;

/**
 * Initializes and returns the active storage instance.
 * @returns {MemoryStore | RedisStore}
 */
export function getStore() {
  if (activeStore) {
    return activeStore;
  }

  const backend = (config.STATE_BACKEND || (config.REDIS_URL ? 'redis' : 'memory')).toLowerCase();

  if (backend === 'redis' && config.REDIS_URL) {
    try {
      activeStore = new RedisStore(config.REDIS_URL);
      privacyLog('info', 'STATE_BACKEND_INITIALIZED', { backend: 'redis' });
    } catch (err) {
      privacyLog('warn', 'REDIS_INIT_FAILED_FALLING_BACK_TO_MEMORY', { error: err.message });
      activeStore = new MemoryStore();
      privacyLog('info', 'STATE_BACKEND_INITIALIZED', { backend: 'memory' });
    }
  } else {
    activeStore = new MemoryStore();
    privacyLog('info', 'STATE_BACKEND_INITIALIZED', { backend: 'memory' });
  }

  return activeStore;
}

/**
 * Overrides the active store instance (useful for testing).
 * @param {object} customStore
 */
export function setStore(customStore) {
  if (activeStore && typeof activeStore.close === 'function') {
    activeStore.close();
  }
  activeStore = customStore;
}

export const store = {
  get: (key) => getStore().get(key),
  set: (key, val, ttlSec) => getStore().set(key, val, ttlSec),
  del: (key) => getStore().del(key),
  incr: (key, amt, ttlSec) => getStore().incr(key, amt, ttlSec),
  sadd: (key, mem) => getStore().sadd(key, mem),
  smembers: (key) => getStore().smembers(key),
  srem: (key, mem) => getStore().srem(key, mem),
  keys: (pattern) => getStore().keys(pattern),
  flushAll: () => getStore().flushAll(),
  getType: () => getStore().getType(),
  close: () => getStore().close?.(),
};
