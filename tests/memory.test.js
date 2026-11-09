import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMemoryFact,
  deleteMemoryFact,
  clearUserMemory,
  setMemoryEnabled,
  listMemoryFacts,
  getMemoryContext,
  handleMemoryCommand,
} from '../src/memory.js';

test('Memory: lifecycle of adding, listing, deleting, and clearing user facts', async () => {
  const anonId = 'u_mem_lifecycle';

  await clearUserMemory(anonId);

  // Add 1st fact
  const add1 = await addMemoryFact(anonId, 'I live in Bengaluru and work in tech');
  assert.strictEqual(add1.success, true);
  assert.ok(add1.id);

  // Add 2nd fact
  const add2 = await addMemoryFact(anonId, 'Vegetarian, allergic to peanuts');
  assert.strictEqual(add2.success, true);

  // List facts
  const listText = listMemoryFacts(anonId);
  assert.ok(listText.includes('Bengaluru'));
  assert.ok(listText.includes('Vegetarian'));

  // Context injection
  const context = getMemoryContext(anonId);
  assert.ok(context.includes('Personal Memory'));
  assert.ok(context.includes('Bengaluru'));
  assert.ok(context.includes('Vegetarian'));

  // Delete 1st fact
  const del1 = await deleteMemoryFact(anonId, add1.id);
  assert.strictEqual(del1.success, true);

  const updatedContext = getMemoryContext(anonId);
  assert.ok(!updatedContext.includes('Bengaluru'));
  assert.ok(updatedContext.includes('Vegetarian'));

  // Clear memory
  const cleared = await clearUserMemory(anonId);
  assert.strictEqual(cleared.success, true);
  assert.strictEqual(getMemoryContext(anonId), '');
});

test('Memory: toggle pause and resume stops context injection without losing facts', async () => {
  const anonId = 'u_mem_toggle';
  await clearUserMemory(anonId);

  await addMemoryFact(anonId, 'Prefers dark mode and concise summaries');
  assert.ok(getMemoryContext(anonId).includes('concise summaries'));

  // Pause
  await setMemoryEnabled(anonId, false);
  assert.strictEqual(getMemoryContext(anonId), '');

  // Resume
  await setMemoryEnabled(anonId, true);
  assert.ok(getMemoryContext(anonId).includes('concise summaries'));

  await clearUserMemory(anonId);
});

test('Memory: handleMemoryCommand routes subcommands correctly', async () => {
  const anonId = 'u_mem_cmd';
  await clearUserMemory(anonId);

  const addRes = await handleMemoryCommand(anonId, '/memory add Enjoys science fiction novels');
  assert.ok(addRes.includes('Memory Saved'));

  const listRes = await handleMemoryCommand(anonId, '/memory');
  assert.ok(listRes.includes('science fiction'));

  const offRes = await handleMemoryCommand(anonId, '/memory off');
  assert.ok(offRes.includes('Paused'));

  const onRes = await handleMemoryCommand(anonId, '/memory on');
  assert.ok(onRes.includes('Enabled'));

  await clearUserMemory(anonId);
});
