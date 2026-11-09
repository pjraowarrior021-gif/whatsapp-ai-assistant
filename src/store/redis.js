/**
 * Redis Store Implementation
 * Powered by ioredis with connection pooling and failover.
 */
import Redis from 'ioredis';
import { privacyLog } from '../privacy.js';

export class RedisStore {
  /**
   * @param {string|object} connectionOptions
   */
  constructor(connectionOptions) {
    this.type = 'redis';
    if (typeof connectionOptions === 'object' && connectionOptions !== null && connectionOptions.isMock) {
      this.client = connectionOptions.client;
    } else {
      const url = typeof connectionOptions === 'string' ? connectionOptions : 'redis://localhost:6379';
      this.client = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: true,
        lazyConnect: false,
        retryStrategy(times) {
          const delay = Math.min(times * 100, 2000);
          return delay;
        },
      });

      this.client.on('error', (err) => {
        privacyLog('error', 'REDIS_CONNECTION_ERROR', { error: err.message });
      });

      this.client.on('connect', () => {
        privacyLog('info', 'REDIS_CONNECTED');
      });
    }
  }

  async get(key) {
    if (!key) return null;
    const raw = await this.client.get(key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async set(key, value, ttlSec = 0) {
    if (!key) return false;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSec > 0) {
      await this.client.set(key, serialized, 'EX', ttlSec);
    } else {
      await this.client.set(key, serialized);
    }
    return true;
  }

  async del(key) {
    if (!key) return false;
    const res = await this.client.del(key);
    return res > 0;
  }

  async incr(key, amount = 1, ttlSec = 0) {
    if (!key) return 0;
    const newVal = await this.client.incrby(key, amount);
    if (newVal === amount && ttlSec > 0) {
      await this.client.expire(key, ttlSec);
    }
    return newVal;
  }

  async sadd(key, member) {
    if (!key || member === undefined) return 0;
    return await this.client.sadd(key, String(member));
  }

  async smembers(key) {
    if (!key) return [];
    return await this.client.smembers(key);
  }

  async srem(key, member) {
    if (!key || member === undefined) return 0;
    return await this.client.srem(key, String(member));
  }

  async keys(pattern = '*') {
    return await this.client.keys(pattern);
  }

  async flushAll() {
    await this.client.flushdb();
    return true;
  }

  async close() {
    try {
      if (typeof this.client.quit === 'function') {
        await this.client.quit();
      } else if (typeof this.client.disconnect === 'function') {
        this.client.disconnect();
      }
    } catch {
      // Ignore cleanup error on exit
    }
  }

  getType() {
    return 'redis';
  }
}
