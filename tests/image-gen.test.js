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

  // 6. Upgraded models: kontext and realism
  const kontext = parseImagePromptOptions('futuristic city --kontext');
  assert.strictEqual(kontext.model, 'kontext');
  const realism = parseImagePromptOptions('tiger in forest --realism');
  assert.strictEqual(realism.model, 'realism');

  // 7. Upgraded aspect ratios: 4:3 and 3:4
  const standard = parseImagePromptOptions('renaissance painting --standard');
  assert.strictEqual(standard.width, 1024);
  assert.strictEqual(standard.height, 768);

  const portraitSd = parseImagePromptOptions('vintage magazine cover --ar 3:4');
  assert.strictEqual(portraitSd.width, 768);
  assert.strictEqual(portraitSd.height, 1024);

  // 8. Upgraded artistic styles: pixel, oil, watercolor, sketch
  const pixel = parseImagePromptOptions('cyberpunk warrior --pixel');
  assert.strictEqual(pixel.style, 'pixel');
  const oil = parseImagePromptOptions('stormy ocean --oil');
  assert.strictEqual(oil.style, 'oil');
  const water = parseImagePromptOptions('cherry blossoms --watercolor');
  assert.strictEqual(water.style, 'watercolor');
  const sketch = parseImagePromptOptions('gothic cathedral --sketch');
  assert.strictEqual(sketch.style, 'sketch');
});

test('ImageGen: generateImageUrl includes selected model parameter', () => {
  const fluxUrl = generateImageUrl('an owl in tree', { model: 'flux' });
  assert.ok(fluxUrl.imageUrl.includes('model=flux'));

  const turboUrl = generateImageUrl('an owl in tree', { model: 'turbo' });
  assert.ok(turboUrl.imageUrl.includes('model=turbo'));

  const kontextUrl = generateImageUrl('an owl in tree', { model: 'kontext' });
  assert.ok(kontextUrl.imageUrl.includes('model=kontext'));
});
