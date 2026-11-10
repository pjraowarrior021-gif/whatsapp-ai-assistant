import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { config } from '../src/config.js';
import {
  parseVideoPrompt,
  parseVideoPromptOptions,
  buildVideoUrl,
  generateVideo,
  MOCK_MP4_BUFFER,
} from '../src/video-gen.js';

test('VideoGen: parseVideoPrompt detects explicit slash commands', () => {
  assert.strictEqual(
    parseVideoPrompt('/video a flying eagle over snowy mountains'),
    'a flying eagle over snowy mountains'
  );
  assert.strictEqual(parseVideoPrompt('/vid cybernetic racing car in neon rain'), 'cybernetic racing car in neon rain');
  assert.strictEqual(parseVideoPrompt('/animate peaceful waterfall at dusk'), 'peaceful waterfall at dusk');
  assert.strictEqual(
    parseVideoPrompt('/motion rocket ascending through storm clouds'),
    'rocket ascending through storm clouds'
  );
  assert.strictEqual(parseVideoPrompt('/reel street dancer in Tokyo'), 'street dancer in Tokyo');
});

test('VideoGen: parseVideoPrompt detects natural language requests', () => {
  assert.strictEqual(
    parseVideoPrompt('create a video of a golden retriever playing with a ball in autumn leaves'),
    'a golden retriever playing with a ball in autumn leaves'
  );
  assert.strictEqual(
    parseVideoPrompt('Can you generate an animation of a spaceship entering hyperdrive?'),
    'a spaceship entering hyperdrive?'
  );
  assert.strictEqual(
    parseVideoPrompt('make a video showing a sunset over the Pacific ocean'),
    'a sunset over the Pacific ocean'
  );
  assert.strictEqual(parseVideoPrompt('please produce a short film depicting ancient Rome'), 'ancient Rome');
});

test('VideoGen: parseVideoPrompt ignores standard conversation and programming questions', () => {
  assert.strictEqual(parseVideoPrompt('What is the capital of France?'), null);
  assert.strictEqual(parseVideoPrompt('How do I play a video in HTML5?'), null);
  assert.strictEqual(parseVideoPrompt('video tags in React'), null);
  assert.strictEqual(parseVideoPrompt(''), null);
  assert.strictEqual(parseVideoPrompt(null), null);
});

test('VideoGen: parseVideoPromptOptions parses aspect ratios, duration, motion presets, and styles', () => {
  // 1. Default configuration
  const def = parseVideoPromptOptions('a red sports car');
  assert.strictEqual(def.prompt, 'a red sports car');
  assert.strictEqual(def.width, 960);
  assert.strictEqual(def.height, 540);
  assert.strictEqual(def.duration, 5);
  assert.strictEqual(def.motion, null);
  assert.strictEqual(def.style, null);

  // 2. Vertical 9:16 and 10s duration
  const vert = parseVideoPromptOptions('neon rain in shibuya --vertical --10s');
  assert.strictEqual(vert.prompt, 'neon rain in shibuya');
  assert.strictEqual(vert.width, 540);
  assert.strictEqual(vert.height, 960);
  assert.strictEqual(vert.duration, 10);

  // 3. Wide 16:9 and camera motion
  const drone = parseVideoPromptOptions('majestic canyon --drone --wide');
  assert.strictEqual(drone.prompt, 'majestic canyon');
  assert.strictEqual(drone.width, 960);
  assert.strictEqual(drone.height, 540);
  assert.strictEqual(drone.motion, 'drone flyover');

  // 4. Square and pan motion
  const square = parseVideoPromptOptions('market in marrakech --square --pan');
  assert.strictEqual(square.width, 576);
  assert.strictEqual(square.height, 576);
  assert.strictEqual(square.motion, 'horizontal pan');

  // 5. Styles: anime, cinematic, 3d, slowmo
  const anime = parseVideoPromptOptions('dragon taking flight --anime --slowmo');
  assert.strictEqual(anime.style, 'anime');
  assert.strictEqual(anime.motion, 'slow motion 120fps');
});

test('VideoGen: buildVideoUrl constructs valid URL endpoint with parameters and model', () => {
  const url = buildVideoUrl('a dolphin leaping out of the water', {
    width: 960,
    height: 540,
    duration: 5,
    model: 'google/veo-3.1-fast',
  });
  assert.ok(url.startsWith('https://gen.pollinations.ai/video/'));
  assert.ok(url.includes('width=960'));
  assert.ok(url.includes('height=540'));
  assert.ok(url.includes('duration=5'));
  assert.ok(url.includes('model=google%2Fveo-3.1-fast'));
  assert.ok(url.includes('nologo=true'));
});

test('VideoGen: generateVideo gracefully returns fallback concept still and missing_api_key when key is unset', async () => {
  const prevConfigKey = config.POLLINATIONS_API_KEY;
  const prevEnvKey = process.env.POLLINATIONS_API_KEY;
  config.POLLINATIONS_API_KEY = '';
  delete process.env.POLLINATIONS_API_KEY;
  try {
    const mockImg = await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();
    const result = await generateVideo('sunset over calm sea', { mockFallbackImage: mockImg, apiKey: '' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'missing_api_key');
    assert.strictEqual(result.statusCode, 401);
    assert.ok(result.fallbackImage);
  } finally {
    config.POLLINATIONS_API_KEY = prevConfigKey;
    if (prevEnvKey) process.env.POLLINATIONS_API_KEY = prevEnvKey;
  }
});

test('VideoGen: generateVideo succeeds with test bypass returning valid MP4 buffer', async () => {
  const result = await generateVideo('a futuristic space station orbiting Saturn --wide', { mock: true });
  assert.ok(result);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mimeType, 'video/mp4');
  assert.ok(result.buffer);
  assert.ok(result.buffer.length > 20);
  assert.strictEqual(result.width, 960);
  assert.strictEqual(result.height, 540);
});

test('VideoGen: generateVideo accepts custom mockBuffer fixture', async () => {
  const customMock = Buffer.from('custom_test_mp4_bytes');
  const result = await generateVideo('a tranquil mountain forest', { mockBuffer: customMock });
  assert.ok(result);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.buffer, customMock);
  assert.strictEqual(result.mimeType, 'video/mp4');
});

test('VideoGen: exports valid ISO Base Media MOCK_MP4_BUFFER fixture', () => {
  assert.ok(Buffer.isBuffer(MOCK_MP4_BUFFER));
  assert.ok(MOCK_MP4_BUFFER.length > 20);
  assert.ok(MOCK_MP4_BUFFER.includes(Buffer.from('ftyp')));
});
