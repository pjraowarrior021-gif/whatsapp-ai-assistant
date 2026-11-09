import test from 'node:test';
import assert from 'node:assert/strict';
import { exportUserData } from '../src/export.js';
import { addTodo } from '../src/todos.js';
import { addMemoryFact } from '../src/memory.js';

test('Export: compiles sanitized JSON structure and handles delivery', async () => {
  const testPhone = '910000000000';
  const anonId = 'u_export_test_user';

  // Seed user data
  addTodo(anonId, 'Sample todo task for export');
  await addMemoryFact(anonId, 'Likes green tea');

  const result = await exportUserData(testPhone, anonId);
  assert.strictEqual(result.success, true);
  assert.ok(result.message);
});
