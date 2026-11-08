import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessageIntoChunks } from '../src/whatsapp.js';

test('WhatsApp: splitMessageIntoChunks should return single chunk for short text', () => {
  const shortText = 'This is a short message.';
  const chunks = splitMessageIntoChunks(shortText, 4000);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0], shortText);
});

test('WhatsApp: splitMessageIntoChunks handles empty or null input gracefully', () => {
  assert.deepStrictEqual(splitMessageIntoChunks(''), ['']);
  assert.deepStrictEqual(splitMessageIntoChunks(null), ['']);
});

test('WhatsApp: splitMessageIntoChunks splits text at paragraph boundary', () => {
  const p1 = 'A'.repeat(500);
  const p2 = 'B'.repeat(500);
  const text = `${p1}\n\n${p2}`;

  // If maxChunkSize is 600, it should split at the \n\n
  const chunks = splitMessageIntoChunks(text, 600);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0], p1);
  assert.strictEqual(chunks[1], p2);
});

test('WhatsApp: splitMessageIntoChunks keeps each chunk under limit for large texts', () => {
  const longText = 'Word '.repeat(2000); // approx 10,000 characters
  const chunks = splitMessageIntoChunks(longText, 4000);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000);
  }

  // Combined text should contain all words (accounting for whitespace normalization)
  const totalReconstructedWords = chunks.join(' ').split(/\s+/).filter(Boolean).length;
  assert.strictEqual(totalReconstructedWords, 2000);
});

test('WhatsApp Media: getMediaUrl returns null on empty input', async () => {
  const { getMediaUrl } = await import('../src/whatsapp.js');
  const result = await getMediaUrl('');
  assert.strictEqual(result, null);
});

test('WhatsApp Media: downloadMediaInMemory returns null on empty input', async () => {
  const { downloadMediaInMemory } = await import('../src/whatsapp.js');
  const result = await downloadMediaInMemory('');
  assert.strictEqual(result, null);
});

test('WhatsApp Media: sendWhatsAppImage returns error on missing parameters', async () => {
  const { sendWhatsAppImage } = await import('../src/whatsapp.js');
  const res = await sendWhatsAppImage('', '');
  assert.strictEqual(res.success, false);
});

test('WhatsApp Media: handles mock test media gracefully without network calls', async () => {
  const { getMediaUrl, downloadMediaInMemory, sendWhatsAppMessage, sendWhatsAppImage } =
    await import('../src/whatsapp.js');

  const mediaMeta = await getMediaUrl('test_sample_media_id');
  assert.ok(mediaMeta);
  assert.ok(mediaMeta.url.includes('mock-test-image.jpg'));

  const downloaded = await downloadMediaInMemory(mediaMeta.url);
  assert.ok(downloaded);
  assert.ok(downloaded.base64);

  const msgRes = await sendWhatsAppMessage('910000000000', 'test');
  assert.strictEqual(msgRes.success, true);

  const imgRes = await sendWhatsAppImage('910000000000', mediaMeta.url);
  assert.strictEqual(imgRes.success, true);

  const bufferRes = await sendWhatsAppImage('910000000000', { buffer: Buffer.from('fake_image') });
  assert.strictEqual(bufferRes.success, true);
});

test('WhatsApp Media: uploadWhatsAppMedia returns error on missing input', async () => {
  const { uploadWhatsAppMedia } = await import('../src/whatsapp.js');
  const res = await uploadWhatsAppMedia(null);
  assert.strictEqual(res.success, false);
});

test('WhatsApp Media: downloadMediaInMemory detects oversize media via Content-Length header', async () => {
  const { downloadMediaInMemory } = await import('../src/whatsapp.js');
  const origFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-length', '200000000']]), // 200MB > 100MB cap
  });

  try {
    const result = await downloadMediaInMemory('https://example.com/oversized-image.jpg');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'too_large');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('WhatsApp Media: downloadMediaInMemory handles fetch timeout gracefully', async () => {
  const { downloadMediaInMemory } = await import('../src/whatsapp.js');
  const origFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  try {
    const result = await downloadMediaInMemory('https://example.com/slow-image.jpg');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'timeout');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('WhatsApp Media: downloadMediaInMemory handles non-200 HTTP responses', async () => {
  const { downloadMediaInMemory } = await import('../src/whatsapp.js');
  const origFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    headers: new Map(),
  });

  try {
    const result = await downloadMediaInMemory('https://example.com/missing-image.jpg');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'http_error');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('WhatsApp Interactive: sendWhatsAppButtons constructs payload and handles response', async () => {
  const { sendWhatsAppButtons } = await import('../src/whatsapp.js');

  // Test missing parameters
  const errRes = await sendWhatsAppButtons('', '');
  assert.strictEqual(errRes.success, false);

  // Test simulation / valid test recipient
  const res = await sendWhatsAppButtons('910000000000', 'Select an option:', [
    { id: 'btn_1', title: 'Option One' },
    { id: 'btn_2', title: 'Option Two' },
  ]);
  assert.strictEqual(res.success, true);
  assert.ok(res.messageId);

  // Test body text exceeding Meta 1024-character limit
  const longText = 'A'.repeat(1500);
  const longRes = await sendWhatsAppButtons('910000000000', longText, [{ id: 'btn_1', title: 'Option One' }]);
  assert.strictEqual(longRes.success, true);
  assert.ok(longRes.messageId);
});

test('WhatsApp Interactive: sendWhatsAppList constructs list payload', async () => {
  const { sendWhatsAppList } = await import('../src/whatsapp.js');

  const errRes = await sendWhatsAppList('', '');
  assert.strictEqual(errRes.success, false);

  const res = await sendWhatsAppList('910000000000', 'Choose from menu:', [
    { id: 'item_1', title: 'Item 1', description: 'First description' },
    { id: 'item_2', title: 'Item 2', description: 'Second description' },
  ]);
  assert.strictEqual(res.success, true);
  assert.ok(res.messageId);
});
