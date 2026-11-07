import test from 'node:test';
import assert from 'node:assert/strict';
import { getActiveModel, setActiveModel } from '../src/gemini.js';

test('Gemini: default model should be set and configurable', () => {
  const current = getActiveModel();
  assert.ok(typeof current === 'string');
  assert.ok(current.length > 0);
});

test('Gemini: setActiveModel updates active model successfully', () => {
  const original = getActiveModel();
  setActiveModel('gemini-1.5-flash');
  assert.strictEqual(getActiveModel(), 'gemini-1.5-flash');

  // Switch back or test with another model
  setActiveModel('gemini-2.5-flash');
  assert.strictEqual(getActiveModel(), 'gemini-2.5-flash');

  // Restore original
  setActiveModel(original);
});

test('Gemini: setActiveModel ignores invalid names', () => {
  const current = getActiveModel();
  setActiveModel('');
  assert.strictEqual(getActiveModel(), current);
  setActiveModel(null);
  assert.strictEqual(getActiveModel(), current);
});

test('Gemini: generateAIResponse handles multimodal image parameter gracefully', async () => {
  const { generateAIResponse } = await import('../src/gemini.js');
  const dummyImage = {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  const reply = await generateAIResponse('Describe this pixel in one word', [], dummyImage);
  assert.ok(typeof reply === 'string');
  assert.ok(reply.length > 0);
});
