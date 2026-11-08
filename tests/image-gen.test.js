import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseImagePrompt, generateImageUrl, generateCleanImage } from '../src/image-gen.js';

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
});
