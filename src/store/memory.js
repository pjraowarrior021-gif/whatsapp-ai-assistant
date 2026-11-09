/**
 * Memory Store Implementation
 * Volatile in-RAM key-value store with TTL support.
 */

export class MemoryStore {
  constructor() {
    this.store = new Map(); // key -> { value, expiresAt: number | null }
    this.type = 'memory';

    // Background TTL cleaner every 30 seconds
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30 * 1000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (item.expiresAt && item.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  async get(key) {
    if (!key) return null;
    const item = this.store.get(key);
    if (!item) return null;

    if (item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    try {
      return JSON.parse(item.value);
    } catch {
      return item.value;
    }
  }

  async set(key, value, ttlSec = 0) {
    if (!key) return false;
    const expiresAt = ttlSec > 0 ? Date.now() + ttlSec * 1000 : null;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    this.store.set(key, { value: serialized, expiresAt });
    return true;
  }

  async del(key) {
    if (!key) return false;
    return this.store.delete(key);
  }

  async incr(key, amount = 1, ttlSec = 0) {
    if (!key) return 0;
    const current = (await this.get(key)) || 0;
    const num = (typeof current === 'number' ? current : parseInt(current, 10)) || 0;
    const newVal = num + amount;

    const existing = this.store.get(key);
    const expiresAt = existing?.expiresAt || (ttlSec > 0 ? Date.now() + ttlSec * 1000 : null);
    this.store.set(key, { value: JSON.stringify(newVal), expiresAt });
    return newVal;
  }

  async sadd(key, member) {
    if (!key || member === undefined) return 0;
    let setObj = await this.get(key);
    if (!Array.isArray(setObj)) {
      setObj = [];
    }
    const memStr = String(member);
    if (!setObj.includes(memStr)) {
      setObj.push(memStr);
      await this.set(key, setObj);
      return 1;
    }
    return 0;
  }

  async smembers(key) {
    if (!key) return [];
    const setObj = await this.get(key);
    return Array.isArray(setObj) ? setObj : [];
  }

  async srem(key, member) {
    if (!key || member === undefined) return 0;
    const setObj = await this.get(key);
    if (!Array.isArray(setObj)) return 0;
    const memStr = String(member);
    const initialLen = setObj.length;
    const filtered = setObj.filter((m) => m !== memStr);
    if (filtered.length !== initialLen) {
      await this.set(key, filtered);
      return 1;
    }
    return 0;
  }

  async keys(pattern = '*') {
    this.cleanupExpired();
    const allKeys = Array.from(this.store.keys());
    if (pattern === '*' || !pattern) {
      return allKeys;
    }
    // Regex wildcard conversion (e.g. "quota:*" -> /^quota:.*$/)
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    return allKeys.filter((k) => regex.test(k));
  }

  async flushAll() {
    this.store.clear();
    return true;
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getType() {
    return 'memory';
  }
}
