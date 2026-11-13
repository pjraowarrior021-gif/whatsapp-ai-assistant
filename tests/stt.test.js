import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeAudioMimeType, isVoiceNote, transcribeAudioBuffer, transcribeWhatsAppAudio } from '../src/stt.js';
import { config } from '../src/config.js';

config.NODE_ENV = 'test';

test('STT: normalizeAudioMimeType normalizes MIME strings correctly', () => {
  assert.strictEqual(normalizeAudioMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.strictEqual(normalizeAudioMimeType('audio/opus'), 'audio/ogg');
  assert.strictEqual(normalizeAudioMimeType('AUDIO/MP4; codecs=mp4a.40.2'), 'audio/mp4');
  assert.strictEqual(normalizeAudioMimeType('audio/amr'), 'audio/amr');
  assert.strictEqual(normalizeAudioMimeType('audio/wav'), 'audio/wav');
  assert.strictEqual(normalizeAudioMimeType(''), 'audio/ogg');
  assert.strictEqual(normalizeAudioMimeType(null), 'audio/ogg');
});

test('STT: isVoiceNote detects WhatsApp voice note payloads', () => {
  assert.strictEqual(isVoiceNote({ type: 'audio', audio: { voice: true } }), true);
  assert.strictEqual(isVoiceNote({ type: 'audio', audio: { id: 'aud_123' } }), true);
  assert.strictEqual(isVoiceNote({ type: 'text', text: { body: 'hello' } }), false);
  assert.strictEqual(isVoiceNote({}), false);
  assert.strictEqual(isVoiceNote(null), false);
});

test('STT: transcribeAudioBuffer validates empty or invalid buffers', async () => {
  const res1 = await transcribeAudioBuffer(null);
  assert.strictEqual(res1.success, false);
  assert.strictEqual(res1.text, '');

  const res2 = await transcribeAudioBuffer(Buffer.alloc(0));
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.text, '');
});

test('STT: transcribeAudioBuffer succeeds in test mode returning mock transcription', async () => {
  const fakeAudio = Buffer.from('RIFF....WAVEfmt ....data....');
  const res = await transcribeAudioBuffer(fakeAudio, 'audio/ogg', {
    mockText: 'Remember to buy groceries at 6 PM.',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.text, 'Remember to buy groceries at 6 PM.');
  assert.strictEqual(res.engine, 'mock-stt');
});

test('STT: transcribeAudioBuffer executes Gemini multimodal audio pipeline with mock client', async () => {
  let capturedModel = '';
  let capturedContents = null;

  const mockGeminiClient = {
    models: {
      generateContent: async ({ model, contents }) => {
        capturedModel = model;
        capturedContents = contents;
        return { text: 'Transcribed text from simulated voice note.' };
      },
    },
  };

  const fakeAudio = Buffer.from('FAKE_AUDIO_BYTES_OGG_OPUS');
  const res = await transcribeAudioBuffer(fakeAudio, 'audio/ogg; codecs=opus', {
    geminiClient: mockGeminiClient,
    model: 'gemini-3.5-flash-lite',
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.text, 'Transcribed text from simulated voice note.');
  assert.strictEqual(capturedModel, 'gemini-3.5-flash-lite');
  assert.ok(Array.isArray(capturedContents));
  assert.strictEqual(capturedContents[1].inlineData.mimeType, 'audio/ogg');
  assert.strictEqual(capturedContents[1].inlineData.data, fakeAudio.toString('base64'));
});

test('STT: transcribeWhatsAppAudio validates inputs and fails gracefully on empty mediaId', async () => {
  const res = await transcribeWhatsAppAudio('');
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('Missing mediaId'));
});
