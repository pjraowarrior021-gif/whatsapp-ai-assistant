import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { config } from '../src/config.js';
import {
  parseVideoPrompt,
  parseVideoPromptOptions,
  buildVideoUrl,
  generateVideo,
  generateVideoWithGradio,
  MOCK_MP4_BUFFER,
  isFfmpegAvailable,
  synthesizeMotionVideo,
  synthesizeStoryboardVideo,
} from '../src/video-gen.js';
import {
  buildFallbackStoryboard,
  generateVideoStoryboard,
  generateVideoStoryboardFromImage,
  setGeminiClient,
} from '../src/gemini.js';

// Hermetic mock client to prevent any external Gemini calls during tests
config.NODE_ENV = 'test';
setGeminiClient({
  models: {
    generateContent: async () => ({
      text: JSON.stringify([
        'Stage 1: establishing shot photorealistic 8k',
        'Stage 2: motion begins photorealistic 8k',
        'Stage 3: peak action photorealistic 8k',
        'Stage 4: climax resolution photorealistic 8k',
      ]),
      candidates: [{ groundingMetadata: null }],
    }),
  },
});

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

  // 6. Explicit 15s duration flag
  const fifteen = parseVideoPromptOptions('aurora borealis --15s');
  assert.strictEqual(fifteen.duration, 15);
  assert.strictEqual(fifteen.hasExplicitDuration, true);
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

test('VideoGen: generateVideo gracefully returns fallback concept still and missing_api_key when key is unset and recovery disabled', async () => {
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
    const result = await generateVideo('sunset over calm sea', {
      mockFallbackImage: mockImg,
      apiKey: '',
      forceCloud: true,
      disableMotionRecovery: true,
      disableFreeRecovery: true,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'missing_api_key');
    assert.strictEqual(result.statusCode, 401);
    assert.ok(result.fallbackImage);
  } finally {
    config.POLLINATIONS_API_KEY = prevConfigKey;
    if (prevEnvKey) process.env.POLLINATIONS_API_KEY = prevEnvKey;
  }
});

test('VideoGen: isFfmpegAvailable detects system ffmpeg binary', () => {
  assert.strictEqual(typeof isFfmpegAvailable(), 'boolean');
});

test('VideoGen: synthesizeMotionVideo synthesizes real MP4 buffer with camera motion', async () => {
  const sampleBuf = await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 60, g: 120, b: 180 } },
  })
    .jpeg()
    .toBuffer();

  const vidBuf = synthesizeMotionVideo(sampleBuf, { width: 320, height: 180, duration: 3, motion: 'pan' });
  if (isFfmpegAvailable()) {
    assert.ok(vidBuf);
    assert.ok(Buffer.isBuffer(vidBuf));
    assert.ok(vidBuf.length > 500);
    assert.ok(vidBuf.includes(Buffer.from('ftyp')));
  } else {
    assert.strictEqual(vidBuf, null);
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

test('VideoGen: generateVideoWithGradio returns mockBuffer in hermetic test mode', async () => {
  const dummy = Buffer.from('mock_gradio_mp4_bytes');
  const res = await generateVideoWithGradio('a sunset over mountains', { mockBuffer: dummy });
  assert.ok(res.ok);
  assert.strictEqual(res.buffer, dummy);
  assert.strictEqual(res.mimeType, 'video/mp4');
});

test('VideoGen: generateVideo supports engine free returning isFreeVideo badge', async () => {
  const dummy = Buffer.from('free_engine_mp4');
  const res = await generateVideo('cinematic cyberpunk street', {
    engine: 'free',
    mockBuffer: dummy,
  });
  assert.ok(res.ok);
  assert.strictEqual(res.isFreeVideo, true);
  assert.strictEqual(res.buffer, dummy);
  assert.strictEqual(res.width, 512);
  assert.strictEqual(res.height, 512);
});

test('VideoGen: generateVideo automatically recovers via Free Gradio engine when cloud API key is missing', async () => {
  const prevKey = config.POLLINATIONS_API_KEY;
  config.POLLINATIONS_API_KEY = '';
  try {
    const dummy = Buffer.from('auto_recovered_free_mp4');
    const res = await generateVideo('ocean waves at dusk', {
      engine: 'cloud',
      apiKey: '',
      mockBuffer: dummy,
    });
    assert.ok(res.ok);
    assert.strictEqual(res.isFreeVideo, true);
    assert.strictEqual(res.buffer, dummy);
  } finally {
    config.POLLINATIONS_API_KEY = prevKey;
  }
});

test('VideoGen: generateVideo enforces minimum 10 to 15 seconds duration', async () => {
  const dummy = Buffer.from('mock_12s_mp4');
  const resDefault = await generateVideo('sunset over calm sea', {
    engine: 'free',
    mockBuffer: dummy,
  });
  assert.ok(resDefault.duration >= 10 && resDefault.duration <= 15);

  const res15 = await generateVideo('sunset over calm sea --15s', {
    engine: 'free',
    mockBuffer: dummy,
  });
  assert.strictEqual(res15.duration, 15);
});

test('VideoGen: buildFallbackStoryboard produces exactly 4 chronological narrative stages', () => {
  const stages = buildFallbackStoryboard('a cyberpunk hoverbike racing through Tokyo', 'pan');
  assert.ok(Array.isArray(stages));
  assert.strictEqual(stages.length, 4);
  assert.ok(stages[0].includes('Stage 1 (Opening)'));
  assert.ok(stages[1].includes('Stage 2 (Development)'));
  assert.ok(stages[2].includes('Stage 3 (Climax)'));
  assert.ok(stages[3].includes('Stage 4 (Resolution)'));
  for (const s of stages) {
    assert.ok(s.includes('cyberpunk hoverbike'));
    assert.ok(s.includes('no watermarks'));
  }
});

test('VideoGen: generateVideoStoryboard falls back deterministically on empty or error', async () => {
  const stages = await generateVideoStoryboard('');
  assert.ok(Array.isArray(stages));
  assert.strictEqual(stages.length, 4);
  assert.ok(stages[0].includes('Stage 1'));
});

test('VideoGen: generateVideoStoryboardFromImage handles image buffer and falls back cleanly', async () => {
  const testImg = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 120, g: 60, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  const stages = await generateVideoStoryboardFromImage(testImg, 'a red sports car');
  assert.ok(Array.isArray(stages));
  assert.strictEqual(stages.length, 4);
  assert.ok(stages[0].includes('red sports car'));
});

test('VideoGen: synthesizeStoryboardVideo produces a valid MP4 from 4 keyframe buffers', async () => {
  const img1 = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .jpeg()
    .toBuffer();
  const img2 = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 50, g: 200, b: 50 } } })
    .jpeg()
    .toBuffer();
  const img3 = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 50, g: 50, b: 200 } } })
    .jpeg()
    .toBuffer();
  const img4 = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 200, g: 150, b: 50 } } })
    .jpeg()
    .toBuffer();

  if (isFfmpegAvailable()) {
    const vidBuf = synthesizeStoryboardVideo([img1, img2, img3, img4], {
      width: 320,
      height: 180,
      duration: 11.6,
    });
    assert.ok(vidBuf);
    assert.ok(Buffer.isBuffer(vidBuf));
    assert.ok(vidBuf.length > 1000);
    assert.ok(vidBuf.includes(Buffer.from('ftyp')));
  } else {
    const vidBuf = synthesizeStoryboardVideo([img1, img2, img3, img4]);
    assert.strictEqual(vidBuf, null);
  }
});

test('VideoGen: generateVideo handles Image-to-Video workflow with imageBuffer', async () => {
  const testImg = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 20, g: 80, b: 140 } },
  })
    .jpeg()
    .toBuffer();

  const dummy = Buffer.from('mock_img2vid_mp4');
  const res = await generateVideo('animate this scene smoothly', {
    imageBuffer: testImg,
    mockBuffer: dummy,
  });
  assert.ok(res.ok);
  assert.strictEqual(res.isImageToVideo, true);
  assert.strictEqual(res.isStoryboardVideo, true);
  assert.strictEqual(res.isFreeVideo, true);
  assert.strictEqual(res.buffer, dummy);
});

test('VideoGen: parseVideoPromptOptions parses model selection flags (--wan, --animatediff, --storyboard)', () => {
  const optWan = parseVideoPromptOptions('/video eagle in sky --wan');
  assert.strictEqual(optWan.model, 'wan2.1');
  assert.strictEqual(optWan.prompt, '/video eagle in sky');

  const optWan21 = parseVideoPromptOptions('neon racing car --wan2.1 --12s');
  assert.strictEqual(optWan21.model, 'wan2.1');
  assert.strictEqual(optWan21.duration, 12);

  const optAd = parseVideoPromptOptions('cherry blossom park --animatediff');
  assert.strictEqual(optAd.model, 'animatediff');

  const optSb = parseVideoPromptOptions('mountain peak at sunset --storyboard');
  assert.strictEqual(optSb.model, 'storyboard');
});

test('VideoGen: generateVideo supports Alibaba Wan 2.1 model returning isWanVideo badge', async () => {
  const dummy = Buffer.from('mock_wan21_mp4_bytes');
  const res = await generateVideo('futuristic spaceship launch --wan', {
    mockBuffer: dummy,
  });
  assert.ok(res.ok);
  assert.strictEqual(res.isFreeVideo, true);
  assert.strictEqual(res.isWanVideo, true);
  assert.strictEqual(res.model, 'wan2.1');
  assert.strictEqual(res.buffer, dummy);
});
