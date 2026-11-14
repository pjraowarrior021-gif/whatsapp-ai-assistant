/**
 * AI Image Generation Module for WhatsApp Assistant
 * Generates high-quality images from text prompts using Generative AI.
 * Powered by FLUX.1 (default SOTA) and SDXL-Turbo with Gemini AI prompt co-pilot.
 * Features an autonomous self-improving prompt and style optimization system with strict safety clamps.
 */
import crypto from 'crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { enhanceImagePrompt, getGeminiClient } from './gemini.js';
import { privacyLog } from './privacy.js';
import { store } from './store/index.js';
import {
  buildSelfImprovedPrompt,
  recordImageGeneration,
  resetImageLearner,
  getImageLearnerState,
  loadImageLearnerState,
  saveImageLearnerState,
  processImageReaction,
  processImageFollowUpFeedback,
  selectLearnedModifiers,
  exportImageLearnerProfile,
  createDefaultState,
  sanitizeModifier,
  applyCircuitBreaker,
} from './image-learner.js';

export const PHOTOREALISTIC_MODIFIERS = 'sharp focus, 8k resolution, crisp glass reflections, distinct textures';

export {
  loadImageLearnerState,
  getImageLearnerState,
  saveImageLearnerState,
  resetImageLearner,
  recordImageGeneration,
  processImageReaction,
  processImageFollowUpFeedback,
  selectLearnedModifiers,
  buildSelfImprovedPrompt,
  exportImageLearnerProfile,
  createDefaultState,
  sanitizeModifier,
  applyCircuitBreaker,
};

/**
 * Computes deterministic SHA-256 cache key for an image prompt, model, and aspect ratio.
 * @param {string} prompt
 * @param {string} [model='gemini-3.1-flash-image']
 * @param {string} [aspect='1:1']
 * @returns {string} SHA-256 hex hash
 */
export function computeImageCacheKey(prompt, model = 'gemini-3.1-flash-image', aspect = '1:1') {
  const p = String(prompt || '')
    .trim()
    .toLowerCase();
  const m = String(model || '')
    .trim()
    .toLowerCase();
  const a = String(aspect || '')
    .trim()
    .toLowerCase();
  return crypto.createHash('sha256').update(`${p}|${m}|${a}`).digest('hex');
}

/**
 * Retrieves a cached WhatsApp media_id from Redis / active store by cacheKey.
 * @param {string} cacheKey
 * @returns {Promise<string|null>}
 */
export async function getCachedImageMediaId(cacheKey) {
  if (!cacheKey) return null;
  try {
    const key = cacheKey.startsWith('image_cache:') ? cacheKey : `image_cache:${cacheKey}`;
    const cached = await store.get(key);
    return cached || null;
  } catch {
    return null;
  }
}

/**
 * Stores a WhatsApp media_id in Redis / active store for image_cache:<hash> with TTL (default 25 days).
 * @param {string} cacheKey
 * @param {string} mediaId
 * @param {number} [ttlSec]
 * @returns {Promise<boolean>}
 */
export async function cacheImageMediaId(cacheKey, mediaId, ttlSec = null) {
  if (!cacheKey || !mediaId) return false;
  try {
    const key = cacheKey.startsWith('image_cache:') ? cacheKey : `image_cache:${cacheKey}`;
    const ttl = ttlSec !== null ? ttlSec : (config.IMAGE_CACHE_TTL_DAYS || 25) * 86400;
    await store.set(key, String(mediaId), ttl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Infers target aspect ratio from keywords in prompt text.
 * @param {string} text
 * @returns {'9:16' | '16:9' | '3:4' | '4:3' | '1:1'}
 */
export function inferAspectRatio(text) {
  if (!text || typeof text !== 'string') return '1:1';
  const lower = text.toLowerCase();
  if (
    /(?:--ar\s+9:16\b|--wallpaper\b|--story\b|--reel\b|--status\b|--tiktok\b|--phone\b|--vertical\b|\bwallpaper\b|\bstory\b|\breels?\b|\btiktok\b|\bphone lockscreen\b|\bvertical\b)/i.test(
      lower
    )
  ) {
    return '9:16';
  }
  if (
    /(?:--ar\s+16:9\b|--wide\b|--landscape\b|--horizontal\b|--banner\b|--desktop\b|--thumbnail\b|\blandscape\b|\bbanner\b|\bdesktop\b|\byoutube thumbnail\b|\bwide angle\b|\bhorizontal\b|\bcinematic aspect\b)/i.test(
      lower
    )
  ) {
    return '16:9';
  }
  if (
    /(?:--ar\s+3:4\b|--portrait\b|--poster\b|\bposter\b|\bportrait photo\b|\bmagazine cover\b|\bbook cover\b)/i.test(
      lower
    )
  ) {
    return '3:4';
  }
  if (
    /(?:--ar\s+4:3\b|--standard\b|--classic\b|\bclassic photo\b|\bstandard photo\b|\bstandard\b|\bclassic\b)/i.test(
      lower
    )
  ) {
    return '4:3';
  }
  return '1:1';
}

/**
 * Selects optimal generative image model based on prompt complexity or explicit model requested.
 * Routes standard requests to gemini-3.1-flash-image and poster/typography/complex layout to gemini-3-pro-image.
 * @param {string} [prompt='']
 * @param {string|null} [explicitModel=null]
 * @returns {string}
 */
export function selectImageModel(prompt = '', explicitModel = null) {
  if (explicitModel) {
    const norm = String(explicitModel).trim().toLowerCase();
    if (norm === 'turbo' || norm === 'fast') return 'turbo';
    if (norm === 'pro' || norm === 'pro-image' || norm === 'gemini-3-pro-image') {
      return config.IMAGE_MODEL_PRO || 'gemini-3-pro-image';
    }
    if (norm === 'flash' || norm === 'flash-image' || norm === 'gemini-3.1-flash-image') {
      return config.IMAGE_MODEL_FAST || 'gemini-3.1-flash-image';
    }
    if (norm === 'flux' || norm === 'realism' || norm === 'kontext') return norm;
    return explicitModel;
  }
  const lower = String(prompt || '').toLowerCase();
  if (
    /\b(poster|typography|infographic|diagram|detailed layout|lettering|calligraphy|text saying|words written|logo with text)\b/i.test(
      lower
    )
  ) {
    return config.IMAGE_MODEL_PRO || 'gemini-3-pro-image';
  }
  return config.IMAGE_MODEL_FAST || 'gemini-3.1-flash-image';
}

/**
 * Checks if user requested an uncompressed / lossless document delivery for the image.
 * @param {string} text
 * @returns {boolean}
 */
export function isLosslessDocumentRequested(text) {
  if (!text || typeof text !== 'string') return false;
  return (
    /(?:^|\s+)--(?:hd|4k|lossless|uncompressed|doc|document)\b/i.test(text) ||
    /\b(?:uncompressed|send as (?:a )?document|lossless(?: quality)?|highest resolution|raw format)\b/i.test(text)
  );
}

/**
 * Parses user input to detect if it is an image generation request.
 * Supports explicit commands (/image, /imagine, /draw) and natural language queries.
 *
 * @param {string} text
 * @returns {string | null} Extracted image prompt, or null if normal conversation
 */
export function parseImagePrompt(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Explicit slash commands
  const slashMatch = trimmed.match(/^\/(?:image|imagine|draw|generate|paint|pic)\s+(.+)$/i);
  if (slashMatch) {
    return slashMatch[1].trim();
  }

  // 2. Natural language triggers (e.g. "generate an image of a neon city")
  const nlMatch = trimmed.match(
    /^(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|make|paint|draw|render|imagine)\s+(?:an?\s+)?(?:image|picture|photo|wallpaper|artwork|drawing|illustration)\s+(?:of|showing|about|depicting|with)?\s*(.+)$/i
  );
  if (nlMatch) {
    return nlMatch[1].trim();
  }

  // 3. "draw me a ..." or "paint a ..." or "imagine a ..."
  const drawMeMatch = trimmed.match(
    /^(?:please\s+)?(?:can\s+you\s+)?(?:draw|paint|sketch|imagine)\s+(?:me\s+)?(?:an?\s+)?(.+)$/i
  );
  if (drawMeMatch) {
    const candidate = drawMeMatch[1].trim();
    // Exclude programming questions like "draw a circle in css / canvas"
    if (!candidate.match(/\b(in|using|with)\s+(css|html|canvas|javascript|python|flutter|svg|code)\b/i)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Parses advanced flags and options from a raw image prompt string.
 * Supports model switching (--fast / --flux), aspect ratios (--wallpaper, --wide),
 * style presets (--anime, --photo, --cyberpunk, --3d), raw mode (--raw), and learner reset (--reset-learner).
 *
 * @param {string} rawPrompt
 * @returns {{ prompt: string, model: string, width: number, height: number, enhance: boolean, style: string | null, resetLearner: boolean, hasExplicitAspect: boolean }}
 */
export function parseImagePromptOptions(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== 'string') {
    return {
      prompt: '',
      model: 'flux',
      width: 1024,
      height: 1024,
      enhance: true,
      style: null,
      resetLearner: false,
      hasExplicitAspect: false,
      hasExplicitModel: false,
      isLossless: false,
    };
  }

  let text = rawPrompt.trim();
  let model = 'flux';
  let width = 1024;
  let height = 1024;
  let enhance = true;
  let style = null;
  let resetLearner = false;
  let hasExplicitAspect = false;
  let hasExplicitModel = false;

  const isLossless = isLosslessDocumentRequested(text);
  if (/(?:^|\s+)--(?:hd|4k|lossless|uncompressed|doc|document)\b/i.test(text)) {
    text = text.replace(/(?:^|\s+)--(?:hd|4k|lossless|uncompressed|doc|document)\b/gi, ' ');
  }

  // 1. Model flags
  if (/(?:^|\s+)--(?:fast|turbo|quick|lightning)\b/i.test(text)) {
    model = 'turbo';
    hasExplicitModel = true;
    text = text.replace(/(?:^|\s+)--(?:fast|turbo|quick|lightning)\b/gi, ' ');
  } else if (/(?:^|\s+)--kontext\b/i.test(text)) {
    model = 'kontext';
    hasExplicitModel = true;
    text = text.replace(/(?:^|\s+)--kontext\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:realism|flux-realism)\b/i.test(text)) {
    model = 'realism';
    hasExplicitModel = true;
    text = text.replace(/(?:^|\s+)--(?:realism|flux-realism)\b/gi, ' ');
  } else if (/(?:^|\s+)--pro\b/i.test(text)) {
    model = config.IMAGE_MODEL_PRO || 'gemini-3-pro-image';
    hasExplicitModel = true;
    text = text.replace(/(?:^|\s+)--pro\b/gi, ' ');
  } else if (/(?:^|\s+)--flash\b/i.test(text)) {
    model = config.IMAGE_MODEL_FAST || 'gemini-3.1-flash-image';
    hasExplicitModel = true;
    text = text.replace(/(?:^|\s+)--flash\b/gi, ' ');
  } else if (/(?:^|\s+)--flux\b/i.test(text)) {
    model = 'flux';
    hasExplicitModel = true;
    text = text.replace(/(?:^|\s+)--flux\b/gi, ' ');
  } else {
    const customModelMatch = text.match(/(?:^|\s+)--model\s+([a-zA-Z0-9_.-]+)\b/i);
    if (customModelMatch) {
      model = customModelMatch[1];
      hasExplicitModel = true;
      text = text.replace(/(?:^|\s+)--model\s+[a-zA-Z0-9_.-]+\b/gi, ' ');
    }
  }

  // 2. Aspect ratio / dimension flags
  if (/(?:^|\s+)--(?:wallpaper|story|portrait|vertical)\b/i.test(text) || /(?:^|\s+)--ar\s+9:16\b/i.test(text)) {
    width = 720;
    height = 1280;
    hasExplicitAspect = true;
    text = text
      .replace(/(?:^|\s+)--(?:wallpaper|story|portrait|vertical)\b/gi, ' ')
      .replace(/(?:^|\s+)--ar\s+9:16\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:wide|landscape|horizontal)\b/i.test(text) || /(?:^|\s+)--ar\s+16:9\b/i.test(text)) {
    width = 1280;
    height = 720;
    hasExplicitAspect = true;
    text = text.replace(/(?:^|\s+)--(?:wide|landscape|horizontal)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+16:9\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:standard|classic)\b/i.test(text) || /(?:^|\s+)--ar\s+4:3\b/i.test(text)) {
    width = 1024;
    height = 768;
    hasExplicitAspect = true;
    text = text.replace(/(?:^|\s+)--(?:standard|classic)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+4:3\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:portrait-sd|tall)\b/i.test(text) || /(?:^|\s+)--ar\s+3:4\b/i.test(text)) {
    width = 768;
    height = 1024;
    hasExplicitAspect = true;
    text = text.replace(/(?:^|\s+)--(?:portrait-sd|tall)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+3:4\b/gi, ' ');
  } else if (/(?:^|\s+)--square\b/i.test(text) || /(?:^|\s+)--ar\s+1:1\b/i.test(text)) {
    width = 1024;
    height = 1024;
    hasExplicitAspect = true;
    text = text.replace(/(?:^|\s+)--square\b/gi, ' ').replace(/(?:^|\s+)--ar\s+1:1\b/gi, ' ');
  } else {
    const inferred = inferAspectRatio(text);
    if (inferred === '9:16') {
      width = 720;
      height = 1280;
    } else if (inferred === '16:9') {
      width = 1280;
      height = 720;
    } else if (inferred === '3:4') {
      width = 768;
      height = 1024;
    } else if (inferred === '4:3') {
      width = 1024;
      height = 768;
    }
  }

  // 3. Raw flag (bypasses Gemini prompt enhancer)
  if (/(?:^|\s+)--raw\b/i.test(text)) {
    enhance = false;
    text = text.replace(/(?:^|\s+)--raw\b/gi, ' ');
  }

  // 3b. Self-improving learner reset flag
  if (/(?:^|\s+)--(?:reset-learner|clear-learner)\b/i.test(text)) {
    resetLearner = true;
    text = text.replace(/(?:^|\s+)--(?:reset-learner|clear-learner)\b/gi, ' ');
  }

  // 4. Style preset flags
  if (/(?:^|\s+)--(?:anime|manga)\b/i.test(text)) {
    style = 'anime';
    text = text.replace(/(?:^|\s+)--(?:anime|manga)\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:photo|real|realistic)\b/i.test(text)) {
    style = 'photo';
    text = text.replace(/(?:^|\s+)--(?:photo|real|realistic)\b/gi, ' ');
  } else if (/(?:^|\s+)--cyberpunk\b/i.test(text)) {
    style = 'cyberpunk';
    text = text.replace(/(?:^|\s+)--cyberpunk\b/gi, ' ');
  } else if (/(?:^|\s+)--3d\b/i.test(text)) {
    style = '3d';
    text = text.replace(/(?:^|\s+)--3d\b/gi, ' ');
  } else if (/(?:^|\s+)--cinematic\b/i.test(text)) {
    style = 'cinematic';
    text = text.replace(/(?:^|\s+)--cinematic\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:pixel|pixelart)\b/i.test(text)) {
    style = 'pixel';
    text = text.replace(/(?:^|\s+)--(?:pixel|pixelart)\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:oil|oilpainting)\b/i.test(text)) {
    style = 'oil';
    text = text.replace(/(?:^|\s+)--(?:oil|oilpainting)\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:watercolor|watercolour)\b/i.test(text)) {
    style = 'watercolor';
    text = text.replace(/(?:^|\s+)--(?:watercolor|watercolour)\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:sketch|drawing|pencil)\b/i.test(text)) {
    style = 'sketch';
    text = text.replace(/(?:^|\s+)--(?:sketch|drawing|pencil)\b/gi, ' ');
  }

  // Clean double spaces
  text = text.replace(/\s{2,}/g, ' ').trim();

  // Detect photorealistic intent from style or keywords
  const isPhotorealistic =
    style === 'photo' ||
    /\b(?:photo|photorealistic|photorealism|realistic|realism|hyperrealistic|dslr|real life)\b/i.test(text);

  return {
    prompt: text,
    model,
    width,
    height,
    enhance,
    style,
    isPhotorealistic,
    resetLearner,
    hasExplicitAspect,
    hasExplicitModel,
    isLossless: Boolean(isLossless),
  };
}

/**
 * Builds a high-resolution generative AI image URL from a text prompt.
 *
 * @param {string} prompt - Cleaned text prompt
 * @param {object} [options]
 * @param {number} [options.width=1024]
 * @param {number} [options.height=1024]
 * @param {string} [options.model='flux'] - 'flux' (SOTA default) or 'turbo' (sub-2s)
 * @param {number} [options.seed]
 * @returns {{ imageUrl: string, prompt: string, model: string }}
 */
export function generateImageUrl(prompt, options = {}) {
  const cleanPrompt = String(prompt).trim();
  const width = options.width || 1024;
  const height = options.height || 1024;
  const model = options.model || 'flux';
  const seed = options.seed || Math.floor(Math.random() * 1000000);
  const encoded = encodeURIComponent(cleanPrompt);
  const enhanceParam = options.enhance ? '&enhance=true' : '';

  const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&model=${model}&nologo=true&nofeed=true&private=true${enhanceParam}`;

  return {
    imageUrl,
    prompt: cleanPrompt,
    model,
  };
}

/**
 * Downloads and cleans generated image binary in-memory.
 * Automatically enhances short prompts using Gemini and learned aesthetic models, injects styles,
 * and crops any corner vector watermark marks via Sharp.
 *
 * @param {string} rawPrompt - User image prompt (may contain flags)
 * @param {object} [userOptions]
 * @param {string} [userOptions.anonId] - Optional anonymized user identifier for personalized learning
 * @returns {Promise<{ buffer: Buffer, mimeType: string, prompt: string, enhancedPrompt: string, fallbackUrl: string, model: string, width: number, height: number, appliedLearning?: object } | null>}
 */
export async function generateCleanImage(rawPrompt, userOptions = {}) {
  const parsed = parseImagePromptOptions(rawPrompt);
  const anonId = userOptions.anonId || null;

  if (parsed.resetLearner && anonId) {
    resetImageLearner(anonId);
  }

  // Check learned preferences if available
  let learnedStyle = null;
  let learnedModel = null;
  let learnedWidth = parsed.width;
  let learnedHeight = parsed.height;

  if (anonId) {
    const learnerState = getImageLearnerState(anonId);
    if (learnerState) {
      // 1. High-confidence learned style (score >= 0.70 and uses >= 3)
      if (!userOptions.style && !parsed.style && learnerState.styles) {
        const topStyleEntry = Object.entries(learnerState.styles).sort(
          (a, b) => (b[1]?.score || 0) - (a[1]?.score || 0)
        )[0];
        if (topStyleEntry && topStyleEntry[1].score >= 0.7 && topStyleEntry[1].uses >= 3) {
          learnedStyle = topStyleEntry[0];
        }
      }

      // 2. Learned model preference if not overridden by prompt flags
      if (
        parsed.model === 'flux' &&
        !userOptions.model &&
        learnerState.preferredModel &&
        learnerState.preferredModel !== 'flux'
      ) {
        learnedModel = learnerState.preferredModel;
      }

      // 3. Learned aspect ratio preference if not explicitly specified by user
      if (!parsed.hasExplicitAspect && !userOptions.width && !userOptions.height) {
        if (learnerState.preferredAspectRatio === '16:9') {
          learnedWidth = 1280;
          learnedHeight = 720;
        } else if (learnerState.preferredAspectRatio === '9:16') {
          learnedWidth = 720;
          learnedHeight = 1280;
        }
      }
    }
  }

  const effectiveModel =
    userOptions.model ||
    (parsed.hasExplicitModel
      ? parsed.model
      : userOptions.mockBuffer
        ? learnedModel || parsed.model
        : selectImageModel(rawPrompt, learnedModel));

  const isLossless = Boolean(parsed.isLossless || userOptions.isLossless);

  const options = {
    model: effectiveModel,
    width: userOptions.width || learnedWidth || 1024,
    height: userOptions.height || learnedHeight || 1024,
    enhance: userOptions.enhance !== undefined ? userOptions.enhance : parsed.enhance,
    style: userOptions.style || parsed.style || learnedStyle,
    seed: userOptions.seed,
    mockBuffer: userOptions.mockBuffer,
    anonId,
  };

  const aspect = parsed.hasExplicitAspect ? `${options.width}:${options.height}` : inferAspectRatio(rawPrompt);
  const cacheKey = computeImageCacheKey(parsed.prompt || rawPrompt, effectiveModel, aspect);

  // Return cached WhatsApp media_id if available (zero re-generation & zero upload cost)
  if (!options.mockBuffer) {
    const cachedMediaId = await getCachedImageMediaId(cacheKey);
    if (cachedMediaId) {
      privacyLog('info', 'IMAGE_CACHE_HIT', { cacheKey, cachedMediaId, model: effectiveModel });
      return {
        buffer: null,
        mimeType: isLossless ? 'image/png' : 'image/jpeg',
        prompt: parsed.prompt,
        enhancedPrompt: parsed.prompt,
        fallbackUrl: '',
        model: effectiveModel,
        width: options.width,
        height: options.height,
        isLossless,
        cacheKey,
        cachedMediaId,
        appliedLearning: null,
      };
    }
  }

  let effectivePrompt = parsed.prompt || String(rawPrompt).trim();

  // Apply style decorators if flag was provided (or learned)
  if (options.style === 'anime') {
    effectivePrompt += ', vibrant anime art style, Studio Ghibli aesthetic, detailed anime illustration';
  } else if (options.style === 'photo') {
    effectivePrompt += `, 8k photorealistic photography, shot on 35mm lens, natural soft lighting, hyper-detailed, ${PHOTOREALISTIC_MODIFIERS}`;
  } else if (options.style === 'cyberpunk') {
    effectivePrompt += ', cyberpunk aesthetic, neon glow, dark futuristic city, volumetric lighting, synthwave';
  } else if (options.style === '3d') {
    effectivePrompt += ', 3D digital render, Unreal Engine 5, Octane render, smooth lighting, high resolution';
  } else if (options.style === 'cinematic') {
    effectivePrompt += ', cinematic movie still, 35mm anamorphic lens, dramatic lighting, 8k resolution, color graded';
  } else if (options.style === 'pixel') {
    effectivePrompt += ', 16-bit pixel art style, retro arcade aesthetic, pixelated detailed textures, sharp pixels';
  } else if (options.style === 'oil') {
    effectivePrompt +=
      ', textured oil painting, visible canvas brushstrokes, rich palette, classical fine art masterpiece';
  } else if (options.style === 'watercolor') {
    effectivePrompt += ', soft watercolor wash, delicate ink outlines, textured paper, fluid gradients, artistic';
  } else if (options.style === 'sketch') {
    effectivePrompt +=
      ', detailed graphite pencil sketch, cross-hatching shading, artist sketchbook page, fine line art';
  }

  // Detect photorealistic intent from flags or natural language
  const isPhotorealistic =
    options.style === 'photo' ||
    Boolean(parsed.isPhotorealistic) ||
    Boolean(userOptions.photorealistic) ||
    /\b(?:photo|photorealistic|photorealism|realistic|realism|hyperrealistic|dslr|real life)\b/i.test(effectivePrompt);

  if (isPhotorealistic && !effectivePrompt.toLowerCase().includes('sharp focus')) {
    effectivePrompt += `, ${PHOTOREALISTIC_MODIFIERS}`;
  }

  // Apply self-improving prompt adjustments with safety clamps:
  let appliedLearning = null;
  if (anonId && options.enhance) {
    const improved = buildSelfImprovedPrompt(effectivePrompt, parsed, anonId);
    effectivePrompt = improved.optimizedPrompt;
    appliedLearning = {
      lighting: improved.appliedLighting,
      composition: improved.appliedComposition,
      quality: improved.appliedQuality,
    };
  }

  // Gemini AI Prompt Co-Pilot: enrich prompts unless --raw or mockBuffer was specified
  let finalPrompt = effectivePrompt;
  if (options.enhance && !options.mockBuffer && effectivePrompt.length < 250) {
    try {
      finalPrompt = await enhanceImagePrompt(effectivePrompt);
    } catch {
      finalPrompt = effectivePrompt;
    }
  }

  // Ensure photorealistic sharpness and detail modifiers are strictly preserved
  if (isPhotorealistic && !finalPrompt.toLowerCase().includes('sharp focus')) {
    finalPrompt += `, ${PHOTOREALISTIC_MODIFIERS}`;
  }

  // Deterministic watermark-free directive guarantee across all prompts
  if (!finalPrompt.toLowerCase().includes('watermark-free')) {
    finalPrompt += ', clean composition, watermark-free, no logos, no text';
  }

  const { imageUrl } = generateImageUrl(finalPrompt, options);

  try {
    let rawBuffer = null;
    let isGeminiSource = false;

    if (options.mockBuffer) {
      rawBuffer = options.mockBuffer;
    } else if (effectiveModel.startsWith('gemini-') && config.GEMINI_API_KEY) {
      try {
        const client = getGeminiClient();
        const geminiRes = await client.models.generateImages({
          model: effectiveModel,
          prompt: finalPrompt,
          config: {
            numberOfImages: 1,
            aspectRatio: aspect,
          },
        });
        const b64 = geminiRes?.generatedImages?.[0]?.image?.imageBytes;
        if (b64) {
          rawBuffer = Buffer.from(b64, 'base64');
          isGeminiSource = true;
          privacyLog('info', 'GEMINI_IMAGE_GENERATED', {
            model: effectiveModel,
            aspect,
            bytes: rawBuffer.length,
          });
        }
      } catch (geminiErr) {
        privacyLog('warn', 'GEMINI_IMAGE_GEN_FALLBACK_TO_POLLINATIONS', {
          error: geminiErr.message,
          model: effectiveModel,
        });
      }
    }

    if (!rawBuffer) {
      const signal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
      let res = await fetch(imageUrl, { signal });
      if (!res.ok && (res.status === 402 || res.status === 429)) {
        try {
          const errData = await res.json();
          const match = (errData?.error?.message || '').match(/Retry after (\d+)s/i);
          const waitSec = match ? Math.min(20, parseInt(match[1], 10) + 1) : 10;
          privacyLog('info', 'IMAGE_GEN_RATE_LIMIT_BACKOFF', { waitSec });
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          const retrySignal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
          res = await fetch(imageUrl, { signal: retrySignal });
        } catch {
          // Ignore parse failure and check status below
        }
      }
      if (!res.ok) {
        return null;
      }

      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (contentLength > config.MEDIA_MAX_BYTES) {
        return null;
      }

      const chunks = [];
      let totalBytes = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          totalBytes += chunk.length;
          if (totalBytes > config.MEDIA_MAX_BYTES) {
            return null;
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      rawBuffer = Buffer.concat(chunks);
    }

    const metadata = await sharp(rawBuffer).metadata();
    const targetWidth = options.width || 1024;
    const targetHeight = options.height || 1024;
    const rawWidth = metadata.width || targetWidth;
    const rawHeight = metadata.height || targetHeight;

    let pipeline = sharp(rawBuffer);

    // If sourced from Pollinations, crop watermark
    if (!isGeminiSource && !options.mockBuffer) {
      const cropHeight = Math.max(10, rawHeight - 45);
      pipeline = pipeline.extract({
        left: 0,
        top: 0,
        width: rawWidth,
        height: cropHeight,
      });
    }

    // Cap longest edge at 1600px (< 5MB, 90% quality)
    pipeline = pipeline.resize({
      width: Math.min(1600, targetWidth),
      height: Math.min(1600, targetHeight),
      fit: 'inside',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    });

    let cleanBuffer;
    let mimeType = 'image/jpeg';
    if (isLossless) {
      cleanBuffer = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      mimeType = 'image/png';
    } else {
      cleanBuffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
    }

    // Record generation for continuous learning
    if (anonId) {
      recordImageGeneration(anonId, {
        prompt: parsed.prompt,
        enhancedPrompt: finalPrompt,
        model: effectiveModel,
        style: options.style,
        aspect: `${options.width}:${options.height}`,
        appliedLighting: appliedLearning?.lighting,
        appliedComposition: appliedLearning?.composition,
        appliedQuality: appliedLearning?.quality,
      });
    }

    return {
      buffer: cleanBuffer,
      mimeType,
      prompt: parsed.prompt,
      enhancedPrompt: finalPrompt,
      fallbackUrl: imageUrl,
      model: effectiveModel,
      width: options.width,
      height: options.height,
      isLossless,
      cacheKey,
      cachedMediaId: null,
      appliedLearning,
    };
  } catch {
    return null;
  }
}
