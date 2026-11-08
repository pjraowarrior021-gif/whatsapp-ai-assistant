import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseImagePrompt, parseImagePromptOptions, generateImageUrl, generateCleanImage } from '../src/image-gen.js';

test('ImageGen: parseImagePrompt detects slash commands', () => {
  assert.strictEqual(parseImagePrompt('/image a cybernetic lion'), 'a cybernetic lion');
  assert.strictEqual(parseImagePrompt('/imagine sunset in Tokyo'), 'sunset in Tokyo');
  assert.strictEqual(parseImagePrompt('/draw a cute baby dragon'), 'a cute baby dragon');
  assert.strictEqual(parseImagePrompt('/generate an oil painting of stars'), 'an oil painting of stars');
});

test('ImageGen: parseImagePrompt detects natural language requests', () => {
  assert.strictEqual(parseImagePrompt('create an image of a red sports car on Mars'), 'a red sports car on Mars');
  assert.strictEqual(parseImagePrompt('Can you generate a picture of an enchanted forest?'), 'an enchanted forest?');
  assert.strictEqual(parseImagePrompt('draw a portrait of an astronaut'), 'portrait of an astronaut');
  assert.strictEqual(parseImagePrompt('paint a landscape with purple mountains'), 'landscape with purple mountains');
  assert.strictEqual(
    parseImagePrompt('imagine an ethereal bioluminescent cyber-forest'),
    'ethereal bioluminescent cyber-forest'
  );
  assert.strictEqual(parseImagePrompt('please imagine a peaceful Japanese garden'), 'peaceful Japanese garden');
});

test('ImageGen: parseImagePrompt ignores normal conversational queries and programming questions', () => {
  assert.strictEqual(parseImagePrompt('What is the weather today?'), null);
  assert.strictEqual(parseImagePrompt('How do I draw a circle in CSS?'), null);
  assert.strictEqual(parseImagePrompt('Can you draw with canvas in javascript?'), null);
  assert.strictEqual(parseImagePrompt(''), null);
  assert.strictEqual(parseImagePrompt(null), null);
});

test('ImageGen: generateImageUrl constructs valid URL with parameters', () => {
  const result = generateImageUrl('a neon cyberpunk street', { width: 1024, height: 1024, seed: 42 });
  assert.strictEqual(result.prompt, 'a neon cyberpunk street');
  assert.ok(result.imageUrl.includes('https://image.pollinations.ai/prompt/'));
  assert.ok(result.imageUrl.includes('width=1024'));
  assert.ok(result.imageUrl.includes('height=1024'));
  assert.ok(result.imageUrl.includes('seed=42'));
});

test('ImageGen: generateCleanImage returns a processed clean image buffer', async () => {
  const sampleBuf = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg()
    .toBuffer();

  const clean = await generateCleanImage('a solitary oak tree on a hill', { mockBuffer: sampleBuf });
  assert.ok(clean);
  assert.ok(clean.buffer);
  assert.strictEqual(clean.mimeType, 'image/jpeg');
  assert.strictEqual(clean.prompt, 'a solitary oak tree on a hill');
  assert.strictEqual(clean.model, 'flux');
});

test('ImageGen: parseImagePromptOptions parses models, aspect ratios, and styles accurately', () => {
  // 1. Default configuration
  const def = parseImagePromptOptions('a red sports car');
  assert.strictEqual(def.prompt, 'a red sports car');
  assert.strictEqual(def.model, 'flux');
  assert.strictEqual(def.width, 1024);
  assert.strictEqual(def.height, 1024);
  assert.strictEqual(def.enhance, true);
  assert.strictEqual(def.style, null);

  // 2. Fast turbo mode
  const fast = parseImagePromptOptions('a cybernetic tiger --fast');
  assert.strictEqual(fast.prompt, 'a cybernetic tiger');
  assert.strictEqual(fast.model, 'turbo');

  // 3. Wallpaper 9:16 aspect ratio
  const wall = parseImagePromptOptions('neon rain in shibuya --wallpaper');
  assert.strictEqual(wall.prompt, 'neon rain in shibuya');
  assert.strictEqual(wall.width, 720);
  assert.strictEqual(wall.height, 1280);

  // 4. Widescreen 16:9 aspect ratio
  const wide = parseImagePromptOptions('majestic mountain lake --wide');
  assert.strictEqual(wide.prompt, 'majestic mountain lake');
  assert.strictEqual(wide.width, 1280);
  assert.strictEqual(wide.height, 720);

  // 5. Styles and raw flag
  const styled = parseImagePromptOptions('anime girl reading --anime --raw');
  assert.strictEqual(styled.prompt, 'anime girl reading');
  assert.strictEqual(styled.style, 'anime');
  assert.strictEqual(styled.enhance, false);

  const photo = parseImagePromptOptions('portrait of astronaut --photo --flux');
  assert.strictEqual(photo.prompt, 'portrait of astronaut');
  assert.strictEqual(photo.style, 'photo');
  assert.strictEqual(photo.model, 'flux');
});

test('ImageGen: generateImageUrl includes selected model parameter', () => {
  const fluxUrl = generateImageUrl('an owl in tree', { model: 'flux' });
  assert.ok(fluxUrl.imageUrl.includes('model=flux'));

  const turboUrl = generateImageUrl('an owl in tree', { model: 'turbo' });
  assert.ok(turboUrl.imageUrl.includes('model=turbo'));
});
