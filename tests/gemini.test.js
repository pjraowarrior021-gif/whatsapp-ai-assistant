import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveModel,
  setActiveModel,
  getCandidateModels,
  setGeminiClient,
  generateAIResponse,
  formatGroundingSources,
  setSearchGrounding,
  getPersona,
  setPersona,
  resetPersona,
  listPersonas,
  enhanceImagePrompt,
} from '../src/gemini.js';
import { config } from '../src/config.js';

test('Gemini: default model should be set and configurable', () => {
  const current = getActiveModel();
  assert.ok(typeof current === 'string');
  assert.ok(current.length > 0);
});

test('Gemini: getCandidateModels respects active model order and de-duplicates', () => {
  const original = getActiveModel();
  setActiveModel('gemini-3.5-flash-lite');
  const candidates = getCandidateModels();

  assert.strictEqual(candidates[0], 'gemini-3.5-flash-lite');
  const uniqueCandidates = [...new Set(candidates)];
  assert.strictEqual(candidates.length, uniqueCandidates.length);

  setActiveModel(original);
});

test('Gemini: setActiveModel updates active model successfully', () => {
  const original = getActiveModel();
  setActiveModel('gemini-1.5-flash');
  assert.strictEqual(getActiveModel(), 'gemini-1.5-flash');

  // Switch back or test with another model
  setActiveModel('gemini-3.5-flash-lite');
  assert.strictEqual(getActiveModel(), 'gemini-3.5-flash-lite');

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

test('Gemini: formatGroundingSources builds compact markdown sources', () => {
  const metadata = {
    groundingChunks: [
      { web: { uri: 'https://news.ycombinator.com', title: 'Hacker News' } },
      { web: { uri: 'https://github.com', title: 'GitHub' } },
      { web: { uri: 'https://github.com', title: 'Duplicate GitHub' } },
      { web: { uri: 'https://google.com', title: 'Google' } },
      { web: { uri: 'https://overflow.com', title: 'Overflow' } },
    ],
  };

  const sources = formatGroundingSources(metadata);
  assert.ok(sources.includes('*Sources:*'));
  assert.ok(sources.includes('[Hacker News](https://news.ycombinator.com)'));
  assert.ok(sources.includes('[GitHub](https://github.com)'));
  assert.ok(sources.includes('[Google](https://google.com)'));
  // Max 3
  assert.ok(!sources.includes('Overflow'));
});

test('Gemini: generateAIResponse handles multimodal image parameter gracefully without network calls', async () => {
  // Mock Gemini client to avoid external network calls
  let calledModel = null;
  const mockClient = {
    models: {
      generateContent: async ({ model }) => {
        calledModel = model;
        return {
          text: 'This is a single white pixel.',
          candidates: [
            {
              groundingMetadata: {
                groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
              },
            },
          ],
        };
      },
    },
  };

  setGeminiClient(mockClient);
  setSearchGrounding(true);

  const dummyImage = {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };

  const reply = await generateAIResponse('Describe this pixel in one word', [], dummyImage);
  assert.ok(typeof reply === 'string');
  assert.ok(reply.includes('white pixel'));
  assert.ok(reply.includes('*Sources:*'));
  assert.strictEqual(calledModel, getActiveModel());

  // Clean up mock
  setGeminiClient(null);
  setSearchGrounding(config.ENABLE_SEARCH_GROUNDING);
});

test('Gemini Persona: listPersonas returns all core personas', () => {
  const personas = listPersonas();
  assert.ok(personas.default);
  assert.ok(personas.coder);
  assert.ok(personas.tutor);
  assert.ok(personas.executive);
});

test('Gemini Persona: getPersona defaults to default and updates with setPersona', () => {
  const anonId = 'u_persona_test_user';
  resetPersona(anonId);
  assert.strictEqual(getPersona(anonId), 'default');

  const setResult = setPersona(anonId, 'coder');
  assert.strictEqual(setResult.success, true);
  assert.strictEqual(getPersona(anonId), 'coder');

  // Case-insensitive
  const setResultTutor = setPersona(anonId, 'TUTOR');
  assert.strictEqual(setResultTutor.success, true);
  assert.strictEqual(getPersona(anonId), 'tutor');

  // Rejects invalid persona
  const invalidResult = setPersona(anonId, 'wizard');
  assert.strictEqual(invalidResult.success, false);
  assert.strictEqual(getPersona(anonId), 'tutor');

  // Reset persona
  resetPersona(anonId);
  assert.strictEqual(getPersona(anonId), 'default');
});

test('Gemini Persona: generateAIResponse respects persona system instruction and forceGrounding', async () => {
  let capturedConfig = null;
  const mockClient = {
    models: {
      generateContent: async ({ config }) => {
        capturedConfig = config;
        return {
          text: 'Response from mock Gemini.',
        };
      },
    },
  };

  setGeminiClient(mockClient);
  setSearchGrounding(false); // Global search grounding is disabled

  const anonId = 'u_persona_exec_user';
  setPersona(anonId, 'executive');

  const response = await generateAIResponse('Give me a brief', [], null, {
    anonId,
    forceGrounding: true,
  });

  assert.strictEqual(response, 'Response from mock Gemini.');
  assert.ok(capturedConfig.systemInstruction.includes('[PERSONA OVERRIDE: EXECUTIVE]'));
  assert.ok(capturedConfig.tools && capturedConfig.tools[0].googleSearch);

  // Clean up
  resetPersona(anonId);
  setGeminiClient(null);
});

test('Gemini: enhanceImagePrompt enhances prompt using mock Gemini client', async () => {
  const mockClient = {
    models: {
      generateContent: async () => ({
        text: 'Cinematic portrait of a cyberpunk cat in neon rain, 8k resolution',
      }),
    },
  };

  setGeminiClient(mockClient);
  const enhanced = await enhanceImagePrompt('a cat');
  assert.strictEqual(enhanced, 'Cinematic portrait of a cyberpunk cat in neon rain, 8k resolution');

  // Empty prompt returns original
  const empty = await enhanceImagePrompt('');
  assert.strictEqual(empty, '');

  setGeminiClient(null);
});
