import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  parseImagePrompt,
  parseImagePromptOptions,
  generateImageUrl,
  generateCleanImage,
  createDefaultState,
  resetImageLearner,
  getImageLearnerState,
  recordImageGeneration,
  processImageReaction,
  processImageFollowUpFeedback,
  selectLearnedModifiers,
  buildSelfImprovedPrompt,
  exportImageLearnerProfile,
  sanitizeModifier,
  applyCircuitBreaker,
  PHOTOREALISTIC_MODIFIERS,
} from '../src/image-gen.js';

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

  // 9. Reset learner flag
  const resetParsed = parseImagePromptOptions('sunset beach --reset-learner');
  assert.strictEqual(resetParsed.prompt, 'sunset beach');
  assert.strictEqual(resetParsed.resetLearner, true);
});

test('ImageGen: generateImageUrl includes selected model parameter', () => {
  const fluxUrl = generateImageUrl('an owl in tree', { model: 'flux' });
  assert.ok(fluxUrl.imageUrl.includes('model=flux'));

  const turboUrl = generateImageUrl('an owl in tree', { model: 'turbo' });
  assert.ok(turboUrl.imageUrl.includes('model=turbo'));

  const kontextUrl = generateImageUrl('an owl in tree', { model: 'kontext' });
  assert.ok(kontextUrl.imageUrl.includes('model=kontext'));
});

/* ========================================================================== */
/* Self-Improving Image Prompt & Style Optimization Tests                     */
/* ========================================================================== */

test('ImageGen Learner: createDefaultState and resetImageLearner initializes and clears state cleanly', () => {
  const userId = 'u_test_learner_init';
  const defaultState = createDefaultState();
  assert.strictEqual(defaultState.version, 1);
  assert.strictEqual(defaultState.preferredModel, 'flux');
  assert.strictEqual(defaultState.preferredAspectRatio, '1:1');
  assert.deepStrictEqual(defaultState.recentGenerations, []);

  // Mutate state in cache
  const state = getImageLearnerState(userId);
  state.preferredModel = 'turbo';
  state.totalGenerations = 10;
  assert.strictEqual(getImageLearnerState(userId).totalGenerations, 10);

  // Reset clears back to fresh state
  const resetOk = resetImageLearner(userId);
  assert.strictEqual(resetOk, true);
  assert.strictEqual(getImageLearnerState(userId).totalGenerations, 0);
  assert.strictEqual(getImageLearnerState(userId).preferredModel, 'flux');
});

test('ImageGen Learner: sanitizeModifier removes markdown, code injections, control chars, and clamps length', () => {
  assert.strictEqual(sanitizeModifier(''), '');
  assert.strictEqual(sanitizeModifier(null), '');
  assert.strictEqual(sanitizeModifier('undefined'), '');
  assert.strictEqual(sanitizeModifier('**cinematic golden hour**'), 'cinematic golden hour');
  assert.strictEqual(
    sanitizeModifier('<script>alert("hack")</script> dramatic rim lighting'),
    'script alert("hack") /script dramatic rim lighting'
  );
  assert.strictEqual(
    sanitizeModifier('check https://malicious.link/payload for soft shadows'),
    'check for soft shadows'
  );

  // Clamps excessive length (> 60 chars)
  const longText =
    'a very long aesthetic modifier that repeats itself excessively to test truncation boundaries in image generation';
  const sanitized = sanitizeModifier(longText);
  assert.ok(sanitized.length <= 60);
});

test('ImageGen Learner: recordImageGeneration stores sliding window of recent generations', () => {
  const userId = 'u_test_sliding_window';
  resetImageLearner(userId);

  for (let i = 1; i <= 7; i++) {
    recordImageGeneration(userId, {
      prompt: `Prompt iteration ${i}`,
      style: i % 2 === 0 ? 'photo' : 'cinematic',
      appliedLighting: `lighting_${i}`,
      appliedComposition: `comp_${i}`,
    });
  }

  const state = getImageLearnerState(userId);
  assert.strictEqual(state.totalGenerations, 7);
  // Bounded sliding window: max 5
  assert.strictEqual(state.recentGenerations.length, 5);
  // Most recent is first
  assert.strictEqual(state.recentGenerations[0].prompt, 'Prompt iteration 7');
});

test('ImageGen Learner: processImageReaction reinforces positive feedback and penalizes negative feedback', () => {
  const userId = 'u_test_reaction_rl';
  resetImageLearner(userId);

  // Record an initial generation
  recordImageGeneration(userId, {
    prompt: 'a majestic mountain peak at dawn',
    style: 'photo',
    appliedLighting: 'volumetric sun rays',
    appliedComposition: 'panoramic wide angle',
    appliedQuality: '8k ultra-sharp detail',
  });

  // 1. Positive emoji reaction (thumbs up)
  const posRes = processImageReaction(userId, '👍');
  assert.strictEqual(posRes.processed, true);
  assert.strictEqual(posRes.feedbackType, 'positive');

  const state = getImageLearnerState(userId);
  assert.strictEqual(state.positiveFeedbackCount, 1);
  assert.ok(state.lighting['volumetric sun rays']);
  assert.ok(state.lighting['volumetric sun rays'].score > 0.5);
  assert.strictEqual(state.lighting['volumetric sun rays'].upvotes, 1);

  // 2. Negative emoji reaction (thumbs down)
  const negRes = processImageReaction(userId, '👎');
  assert.strictEqual(negRes.processed, true);
  assert.strictEqual(negRes.feedbackType, 'negative');
  assert.strictEqual(state.negativeFeedbackCount, 1);
  assert.strictEqual(state.consecutiveNegativeCount, 1);

  // Neutral emoji should not be processed
  const neutralRes = processImageReaction(userId, '🤔');
  assert.strictEqual(neutralRes.processed, false);
});

test('ImageGen Learner: consecutive negative reactions triggers circuit breaker auto-damping', () => {
  const userId = 'u_test_circuit_breaker';
  resetImageLearner(userId);

  recordImageGeneration(userId, {
    prompt: 'experimental surreal portrait',
    style: '3d',
    appliedLighting: 'harsh neon glare',
  });

  const state = getImageLearnerState(userId);
  state.lighting['harsh neon glare'] = { score: 0.9, uses: 3, upvotes: 3, downvotes: 0 };

  // Trigger 3 negative reactions in a row
  processImageReaction(userId, '👎');
  processImageReaction(userId, '👎');
  processImageReaction(userId, '👎');

  // Circuit breaker should reset consecutive count and soften scores
  assert.strictEqual(state.consecutiveNegativeCount, 0);
  assert.ok(state.lighting['harsh neon glare'].score < 0.9);

  // Direct manual circuit breaker trigger test
  state.consecutiveNegativeCount = 3;
  applyCircuitBreaker(state);
  assert.strictEqual(state.consecutiveNegativeCount, 0);
});

test('ImageGen Learner: natural language feedback detects critiques and learns corrections', () => {
  const userId = 'u_test_nl_feedback';
  resetImageLearner(userId);

  // 1. Critique: Too Dark -> Learns brighter ambient lighting and negative underexposed modifier
  const resDark = processImageFollowUpFeedback(userId, 'The image is way too dark, make it brighter');
  assert.strictEqual(resDark.learned, true);
  assert.ok(resDark.matchedRules.includes('critique_too_dark'));

  const state = getImageLearnerState(userId);
  assert.ok(state.negativeModifiers.some((m) => m.includes('dark')));

  // 2. Critique: Blurry -> Learns ultra-sharp focus and negative blur modifier
  const resBlur = processImageFollowUpFeedback(userId, 'This is too blurry and out of focus');
  assert.strictEqual(resBlur.learned, true);
  assert.ok(resBlur.matchedRules.includes('critique_blurry'));
  assert.ok(state.negativeModifiers.some((m) => m.includes('blurry')));

  // 3. Critique: Anatomy / Hands -> Learns anatomically accurate prompt and negative mutant hands modifier
  const resHands = processImageFollowUpFeedback(userId, 'The hands look weird and have extra fingers');
  assert.strictEqual(resHands.learned, true);
  assert.ok(resHands.matchedRules.includes('critique_anatomy'));
  assert.ok(state.negativeModifiers.some((m) => m.includes('mutated hands')));

  // 4. Preference: Realism
  const resReal = processImageFollowUpFeedback(userId, 'I prefer photorealistic style, make it more realistic');
  assert.strictEqual(resReal.learned, true);
  assert.ok(resReal.matchedRules.includes('preference_realism'));
  assert.strictEqual(state.preferredModel, 'realism');

  // 5. Preference: 16:9 Widescreen
  const resAspect = processImageFollowUpFeedback(userId, 'Always make future images 16:9 widescreen');
  assert.strictEqual(resAspect.learned, true);
  assert.strictEqual(state.preferredAspectRatio, '16:9');
});

test('ImageGen Learner: selectLearnedModifiers & buildSelfImprovedPrompt respects confidence thresholds and safety limits', () => {
  const userId = 'u_test_confidence_and_clamps';
  resetImageLearner(userId);

  const state = getImageLearnerState(userId);
  // Add an item below confidence threshold or usage threshold
  state.lighting['subtle moonlight'] = { score: 0.52, uses: 1, upvotes: 0, downvotes: 0 };
  // Add high-confidence qualified item
  state.lighting['golden hour sunset lighting'] = { score: 0.85, uses: 4, upvotes: 4, downvotes: 0 };
  state.composition['cinematic low-angle perspective'] = { score: 0.78, uses: 3, upvotes: 3, downvotes: 0 };
  state.negativeModifiers = ['blurry', 'extra limbs'];

  const selected = selectLearnedModifiers(userId);
  assert.strictEqual(selected.lighting, 'golden hour sunset lighting');
  assert.strictEqual(selected.composition, 'cinematic low-angle perspective');
  assert.deepStrictEqual(selected.negatives, ['blurry', 'extra limbs']);

  // Build self-improved prompt
  const improved = buildSelfImprovedPrompt('a warrior standing on a mountain', {}, userId);
  assert.ok(improved.optimizedPrompt.includes('golden hour sunset lighting'));
  assert.ok(improved.optimizedPrompt.includes('cinematic low-angle perspective'));
  assert.ok(improved.optimizedPrompt.includes('avoiding: blurry, extra limbs'));

  // Safety Clamp: If user prompt is already long (> 220 chars), skip modifier injections to prevent prompt bloat
  const veryLongPrompt = 'a '.repeat(120);
  const clamped = buildSelfImprovedPrompt(veryLongPrompt, {}, userId);
  assert.strictEqual(clamped.appliedLighting, null);
  assert.strictEqual(clamped.appliedComposition, null);

  // Safety Clamp: If user prompt specifies --raw flag, bypass all learned injections
  const rawImproved = buildSelfImprovedPrompt('a serene lake', { enhance: false }, userId);
  assert.strictEqual(rawImproved.appliedLighting, null);
  assert.strictEqual(rawImproved.appliedComposition, null);
});

test('ImageGen: generateCleanImage adapts prompt, applies learned lighting/quality, and returns appliedLearning', async () => {
  const userId = 'u_test_clean_image_learning';
  resetImageLearner(userId);

  const state = getImageLearnerState(userId);
  state.lighting['radiant neon backlighting'] = { score: 0.8, uses: 3, upvotes: 3, downvotes: 0 };
  state.preferredAspectRatio = '16:9';

  const sampleBuf = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 50, g: 100, b: 150 },
    },
  })
    .jpeg()
    .toBuffer();

  const clean = await generateCleanImage('a sleek cybernetic motorcycle', {
    mockBuffer: sampleBuf,
    anonId: userId,
  });

  assert.ok(clean);
  assert.ok(clean.buffer);
  assert.strictEqual(clean.mimeType, 'image/jpeg');
  assert.ok(clean.appliedLearning);
  assert.strictEqual(clean.appliedLearning.lighting, 'radiant neon backlighting');
  // Learned aspect ratio applied: 1280x720
  assert.strictEqual(clean.width, 1280);
  assert.strictEqual(clean.height, 720);

  // Verify generation was automatically recorded in state
  const updatedState = getImageLearnerState(userId);
  assert.strictEqual(updatedState.totalGenerations, 1);
  assert.strictEqual(updatedState.recentGenerations[0].appliedLighting, 'radiant neon backlighting');
});

test('ImageGen Learner: exportImageLearnerProfile outputs sanitized stats', () => {
  const userId = 'u_test_export_profile';
  resetImageLearner(userId);

  const state = getImageLearnerState(userId);
  state.totalGenerations = 12;
  state.positiveFeedbackCount = 9;
  state.negativeFeedbackCount = 2;
  state.styles['photo'] = { score: 0.88, uses: 8, upvotes: 7, downvotes: 1 };
  state.styles['anime'] = { score: 0.42, uses: 3, upvotes: 1, downvotes: 2 };
  state.lighting['golden hour'] = { score: 0.85, uses: 6, upvotes: 5, downvotes: 1 };
  state.negativeModifiers = ['blurry', 'mutated hands'];

  const profile = exportImageLearnerProfile(userId);
  assert.strictEqual(profile.totalGenerations, 12);
  assert.strictEqual(profile.positiveReactions, 9);
  assert.strictEqual(profile.negativeReactions, 2);
  assert.strictEqual(profile.topStyles[0].style, 'photo');
  assert.strictEqual(profile.topStyles[0].score, 0.88);
  assert.strictEqual(profile.topLighting[0].lighting, 'golden hour');
  assert.deepStrictEqual(profile.learnedNegativeModifiers, ['blurry', 'mutated hands']);
});

test('ImageGen: generateImageUrl strictly enforces FLUX, 1024x1024, and nologo parameters', () => {
  const result = generateImageUrl('a majestic golden eagle');
  assert.strictEqual(result.model, 'flux');
  assert.ok(result.imageUrl.includes('model=flux'));
  assert.ok(result.imageUrl.includes('width=1024'));
  assert.ok(result.imageUrl.includes('height=1024'));
  assert.ok(result.imageUrl.includes('nologo=true'));
  assert.ok(result.imageUrl.includes('nofeed=true'));
  assert.ok(result.imageUrl.includes('private=true'));
});

test('ImageGen: parseImagePromptOptions identifies photorealistic intent from flags and keywords', () => {
  const photoFlag = parseImagePromptOptions('vintage classic car --photo');
  assert.strictEqual(photoFlag.style, 'photo');
  assert.strictEqual(photoFlag.isPhotorealistic, true);

  const realFlag = parseImagePromptOptions('portrait of a sailor --realistic');
  assert.strictEqual(realFlag.style, 'photo');
  assert.strictEqual(realFlag.isPhotorealistic, true);

  const naturalPhoto = parseImagePromptOptions('photorealistic close up of a crystal whiskey glass on a wooden table');
  assert.strictEqual(naturalPhoto.isPhotorealistic, true);

  const nonPhoto = parseImagePromptOptions('retro 8-bit arcade spaceship');
  assert.strictEqual(nonPhoto.isPhotorealistic, false);
});

test('ImageGen: generateCleanImage appends photorealistic sharpness modifiers and preserves 1024x1024 output', async () => {
  const sample1024 = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: { r: 50, g: 80, b: 120 },
    },
  })
    .jpeg()
    .toBuffer();

  const clean = await generateCleanImage('a luxury mechanical wristwatch with exposed gears --photo', {
    mockBuffer: sample1024,
  });

  assert.ok(clean);
  assert.ok(clean.buffer);
  assert.strictEqual(clean.width, 1024);
  assert.strictEqual(clean.height, 1024);
  assert.strictEqual(clean.model, 'flux');
  assert.ok(clean.enhancedPrompt.includes(PHOTOREALISTIC_MODIFIERS));
  assert.ok(clean.enhancedPrompt.includes('sharp focus'));
  assert.ok(clean.enhancedPrompt.includes('8k resolution'));
  assert.ok(clean.enhancedPrompt.includes('crisp glass reflections'));
  assert.ok(clean.enhancedPrompt.includes('distinct textures'));

  // Inspect output metadata using sharp
  const outputMeta = await sharp(clean.buffer).metadata();
  assert.strictEqual(outputMeta.width, 1024);
  assert.strictEqual(outputMeta.height, 1024);
  assert.strictEqual(outputMeta.format, 'jpeg');
});
