import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTextForSpeech, synthesizeSpeech } from '../src/tts.js';

test('TTS: splitTextForSpeech cleans markdown and produces speech-ready chunks', () => {
  const markdownText = `*Important Notice:*
This is a _clear_ test with \`inline code\` and [a link](https://example.com).
Visit https://example.com for more information!`;

  const chunks = splitTextForSpeech(markdownText);
  assert.ok(Array.isArray(chunks));
  assert.ok(chunks.length > 0);

  const combined = chunks.join(' ');
  // Markdown asterisks, underscores, and backticks should be stripped
  assert.ok(!combined.includes('*'));
  assert.ok(!combined.includes('`'));
  assert.ok(combined.includes('Important Notice'));
  assert.ok(combined.includes('clear test'));
});

test('TTS: splitTextForSpeech handles empty or null input gracefully', () => {
  assert.deepStrictEqual(splitTextForSpeech(''), []);
  assert.deepStrictEqual(splitTextForSpeech(null), []);
});

test('TTS: synthesizeSpeech returns null for empty text', async () => {
  const result = await synthesizeSpeech('');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'empty_text');
});

test('TTS: synthesizeSpeech returns in-memory audio buffer with mocked endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const mockAudioBuffer = Buffer.from([0xff, 0xfb, 0x90, 0x44]); // Dummy MP3 sync frame

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => mockAudioBuffer.buffer,
  });

  try {
    const result = await synthesizeSpeech('Hello world! Welcome to the assistant.');
    assert.strictEqual(result.ok, true);
    assert.ok(Buffer.isBuffer(result.buffer));
    assert.ok(result.buffer.length > 0);
    assert.strictEqual(result.mimeType, 'audio/mpeg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
