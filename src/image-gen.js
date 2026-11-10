/**
 * AI Image Generation Module for WhatsApp Assistant
 * Generates high-quality images from text prompts using Generative AI.
 * Powered by FLUX.1 (default SOTA) and SDXL-Turbo with Gemini AI prompt co-pilot.
 */
import sharp from 'sharp';
import { config } from './config.js';
import { enhanceImagePrompt } from './gemini.js';

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
 * style presets (--anime, --photo, --cyberpunk, --3d), and raw mode (--raw).
 *
 * @param {string} rawPrompt
 * @returns {{ prompt: string, model: 'flux' | 'turbo', width: number, height: number, enhance: boolean, style: string | null }}
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
    };
  }

  let text = rawPrompt.trim();
  let model = 'flux';
  let width = 1024;
  let height = 1024;
  let enhance = true;
  let style = null;

  // 1. Model flags
  if (/(?:^|\s+)--(?:fast|turbo|quick|lightning)\b/i.test(text)) {
    model = 'turbo';
    text = text.replace(/(?:^|\s+)--(?:fast|turbo|quick|lightning)\b/gi, ' ');
  } else if (/(?:^|\s+)--kontext\b/i.test(text)) {
    model = 'kontext';
    text = text.replace(/(?:^|\s+)--kontext\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:realism|flux-realism)\b/i.test(text)) {
    model = 'realism';
    text = text.replace(/(?:^|\s+)--(?:realism|flux-realism)\b/gi, ' ');
  } else if (/(?:^|\s+)--flux\b/i.test(text)) {
    model = 'flux';
    text = text.replace(/(?:^|\s+)--flux\b/gi, ' ');
  } else {
    const customModelMatch = text.match(/(?:^|\s+)--model\s+([a-zA-Z0-9_.-]+)\b/i);
    if (customModelMatch) {
      model = customModelMatch[1];
      text = text.replace(/(?:^|\s+)--model\s+[a-zA-Z0-9_.-]+\b/gi, ' ');
    }
  }

  // 2. Aspect ratio / dimension flags
  if (/(?:^|\s+)--(?:wallpaper|story|portrait|vertical)\b/i.test(text) || /(?:^|\s+)--ar\s+9:16\b/i.test(text)) {
    width = 720;
    height = 1280;
    text = text
      .replace(/(?:^|\s+)--(?:wallpaper|story|portrait|vertical)\b/gi, ' ')
      .replace(/(?:^|\s+)--ar\s+9:16\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:wide|landscape|horizontal)\b/i.test(text) || /(?:^|\s+)--ar\s+16:9\b/i.test(text)) {
    width = 1280;
    height = 720;
    text = text.replace(/(?:^|\s+)--(?:wide|landscape|horizontal)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+16:9\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:standard|classic)\b/i.test(text) || /(?:^|\s+)--ar\s+4:3\b/i.test(text)) {
    width = 1024;
    height = 768;
    text = text.replace(/(?:^|\s+)--(?:standard|classic)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+4:3\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:portrait-sd|tall)\b/i.test(text) || /(?:^|\s+)--ar\s+3:4\b/i.test(text)) {
    width = 768;
    height = 1024;
    text = text.replace(/(?:^|\s+)--(?:portrait-sd|tall)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+3:4\b/gi, ' ');
  } else if (/(?:^|\s+)--square\b/i.test(text) || /(?:^|\s+)--ar\s+1:1\b/i.test(text)) {
    width = 1024;
    height = 1024;
    text = text.replace(/(?:^|\s+)--square\b/gi, ' ').replace(/(?:^|\s+)--ar\s+1:1\b/gi, ' ');
  }

  // 3. Raw flag (bypasses Gemini prompt enhancer)
  if (/(?:^|\s+)--raw\b/i.test(text)) {
    enhance = false;
    text = text.replace(/(?:^|\s+)--raw\b/gi, ' ');
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

  return {
    prompt: text,
    model,
    width,
    height,
    enhance,
    style,
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

  const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&model=${model}&nologo=true${enhanceParam}`;

  return {
    imageUrl,
    prompt: cleanPrompt,
    model,
  };
}

/**
 * Downloads and cleans generated image binary in-memory.
 * Automatically enhances short prompts using Gemini, injects styles,
 * and crops any corner vector watermark marks via Sharp.
 *
 * @param {string} rawPrompt - User image prompt (may contain flags)
 * @param {object} [userOptions]
 * @returns {Promise<{ buffer: Buffer, mimeType: string, prompt: string, enhancedPrompt: string, fallbackUrl: string, model: string, width: number, height: number } | null>}
 */
export async function generateCleanImage(rawPrompt, userOptions = {}) {
  const parsed = parseImagePromptOptions(rawPrompt);
  const options = {
    model: userOptions.model || parsed.model || 'flux',
    width: userOptions.width || parsed.width || 1024,
    height: userOptions.height || parsed.height || 1024,
    enhance: userOptions.enhance !== undefined ? userOptions.enhance : parsed.enhance,
    style: userOptions.style || parsed.style,
    seed: userOptions.seed,
    mockBuffer: userOptions.mockBuffer,
  };

  let effectivePrompt = parsed.prompt || String(rawPrompt).trim();

  // Apply style decorators if flag was provided
  if (options.style === 'anime') {
    effectivePrompt += ', vibrant anime art style, Studio Ghibli aesthetic, detailed anime illustration';
  } else if (options.style === 'photo') {
    effectivePrompt += ', 8k photorealistic photography, shot on 35mm lens, natural soft lighting, hyper-detailed';
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

  // Gemini AI Prompt Co-Pilot: enrich prompts unless --raw or mockBuffer was specified
  let finalPrompt = effectivePrompt;
  if (options.enhance && !options.mockBuffer && effectivePrompt.length < 250) {
    try {
      finalPrompt = await enhanceImagePrompt(effectivePrompt);
    } catch {
      finalPrompt = effectivePrompt;
    }
  }

  const { imageUrl } = generateImageUrl(finalPrompt, options);

  try {
    let rawBuffer;
    if (options.mockBuffer) {
      rawBuffer = options.mockBuffer;
    } else {
      const signal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
      const res = await fetch(imageUrl, { signal });
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

    // The platform watermark resides in the bottom-right corner (~45px high).
    // Extracting height minus 45px removes the text and vector mark cleanly in memory.
    const origHeight = metadata.height || options.height || 1024;
    const cropHeight = Math.max(10, origHeight - 45);
    const cleanBuffer = await sharp(rawBuffer)
      .extract({
        left: 0,
        top: 0,
        width: metadata.width || options.width || 1024,
        height: cropHeight,
      })
      .jpeg({ quality: 95 })
      .toBuffer();

    return {
      buffer: cleanBuffer,
      mimeType: 'image/jpeg',
      prompt: parsed.prompt,
      enhancedPrompt: finalPrompt,
      fallbackUrl: imageUrl,
      model: options.model,
      width: options.width,
      height: options.height,
    };
  } catch {
    return null;
  }
}
