import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import { getStore, setStore, store } from '../src/store/index.js';

/**
 * Creates an in-memory mock client mimicking the ioredis interface for contract tests.
 */
function createMockRedisClient() {
  const map = new Map();
  const sets = new Map();

  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, val) {
      map.set(key, String(val));
      return 'OK';
    },
    async del(key) {
      const existed = map.delete(key);
      sets.delete(key);
      return existed ? 1 : 0;
    },
    async incrby(key, amount) {
      const cur = parseInt(map.get(key) || '0', 10);
      const next = cur + amount;
      map.set(key, String(next));
      return next;
    },
    async expire(_key, _sec) {
      return 1;
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      const s = sets.get(key);
      const existed = s.has(member);
      s.add(member);
      return existed ? 0 : 1;
    },
    async smembers(key) {
      if (!sets.has(key)) return [];
      return Array.from(sets.get(key));
    },
    async srem(key, member) {
      if (!sets.has(key)) return 0;
      const s = sets.get(key);
      const existed = s.delete(member);
      return existed ? 1 : 0;
    },
    async keys(pattern = '*') {
      const all = Array.from(new Set([...map.keys(), ...sets.keys()]));
      if (pattern === '*' || !pattern) return all;
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const reg = new RegExp(`^${escaped}$`);
      return all.filter((k) => reg.test(k));
    },
    async flushdb() {
      map.clear();
      sets.clear();
      return 'OK';
    },
    async quit() {
      return 'OK';
    },
  };
}

const implementations = [
  { name: 'MemoryStore', create: () => new MemoryStore() },
  {
    name: 'RedisStore (contract via mock)',
    create: () => new RedisStore({ isMock: true, client: createMockRedisClient() }),
  },
];

for (const { name, create } of implementations) {
  test(`Store Contract: [${name}] supports get, set, del, incr, set operations and TTL`, async () => {
    const s = create();

    // 1. get / set
    assert.strictEqual(await s.get('nonexistent'), null);
    await s.set('user:101', { name: 'Alice', role: 'admin' });
    const user = await s.get('user:101');
    assert.deepStrictEqual(user, { name: 'Alice', role: 'admin' });

    // 2. del
    assert.strictEqual(await s.del('user:101'), true);
    assert.strictEqual(await s.get('user:101'), null);

    // 3. incr
    assert.strictEqual(await s.incr('counter', 1), 1);
    assert.strictEqual(await s.incr('counter', 5), 6);
    assert.strictEqual(await s.get('counter'), 6);

    // 4. Sets (sadd, smembers, srem)
    assert.strictEqual(await s.sadd('tags:item1', 'ai'), 1);
    assert.strictEqual(await s.sadd('tags:item1', 'whatsapp'), 1);
    assert.strictEqual(await s.sadd('tags:item1', 'ai'), 0); // Duplicate
    const members = await s.smembers('tags:item1');
    assert.ok(members.includes('ai'));
    assert.ok(members.includes('whatsapp'));
    assert.strictEqual(await s.srem('tags:item1', 'ai'), 1);
    assert.strictEqual(await s.srem('tags:item1', 'nonexistent'), 0);

    // 5. keys matching
    await s.set('quota:user:2026-11-09:u1', 5);
    await s.set('quota:user:2026-11-09:u2', 10);
    await s.set('session:u1', 'active');
    const quotaKeys = await s.keys('quota:user:*');
    assert.strictEqual(quotaKeys.length, 2);

    // 6. flushAll
    await s.flushAll();
    const remaining = await s.keys('*');
    assert.strictEqual(remaining.length, 0);

    // 7. Type identification
    assert.ok(typeof s.getType() === 'string');

    if (typeof s.close === 'function') {
      await s.close();
    }
  });
}

test('Store Factory: getStore defaults to memory and allows custom setStore', async () => {
  const defaultStore = getStore();
  assert.strictEqual(defaultStore.getType(), 'memory');

  const customMem = new MemoryStore();
  setStore(customMem);
  assert.strictEqual(store.getType(), 'memory');

  await store.set('test_key', 'hello_world');
  assert.strictEqual(await store.get('test_key'), 'hello_world');
  await store.del('test_key');

  // Restore default
  setStore(defaultStore);
});
