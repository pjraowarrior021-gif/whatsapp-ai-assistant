/**
 * AI Image Generation Module for WhatsApp Assistant
 * Generates high-quality images from text prompts using Generative AI.
 */
import sharp from 'sharp';

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
    /^(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|make|paint|draw|render)\s+(?:an?\s+)?(?:image|picture|photo|wallpaper|artwork|drawing|illustration)\s+(?:of|showing|about|depicting|with)?\s*(.+)$/i
  );
  if (nlMatch) {
    return nlMatch[1].trim();
  }

  // 3. "draw me a ..." or "paint a ..."
  const drawMeMatch = trimmed.match(
    /^(?:please\s+)?(?:can\s+you\s+)?(?:draw|paint|sketch)\s+(?:me\s+)?(?:an?\s+)?(.+)$/i
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
 * Builds a high-resolution, enhanced generative AI image URL from a text prompt.
 *
 * @param {string} prompt - Cleaned text prompt
 * @param {object} [options]
 * @param {number} [options.width=1024]
 * @param {number} [options.height=1024]
 * @param {number} [options.seed]
 * @returns {{ imageUrl: string, prompt: string }}
 */
export function generateImageUrl(prompt, options = {}) {
  const cleanPrompt = String(prompt).trim();
  const width = options.width || 1024;
  const height = options.height || 1024;
  const seed = options.seed || Math.floor(Math.random() * 1000000);
  const encoded = encodeURIComponent(cleanPrompt);
  const enhanceParam = options.enhance ? '&enhance=true' : '';

  // Ultra-fast zero-latency generation (sub-second response without prompt expansion bottleneck)
  const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&seed=${seed}&nologo=true${enhanceParam}`;

  return {
    imageUrl,
    prompt: cleanPrompt,
  };
}

/**
 * Downloads and cleans generated image binary in-memory.
 * Crops any corner vector watermark marks (e.g. platform logo overlay)
 * guaranteeing a completely clean, pristine image output with zero vector marks.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @returns {Promise<{ buffer: Buffer, mimeType: string, prompt: string, fallbackUrl: string } | null>}
 */
export async function generateCleanImage(prompt, options = {}) {
  const { imageUrl, prompt: cleanPrompt } = generateImageUrl(prompt, options);

  try {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      return null;
    }

    const rawBuffer = Buffer.from(await res.arrayBuffer());
    const metadata = await sharp(rawBuffer).metadata();

    // The platform watermark resides in the bottom-right corner (~45px high).
    // Extracting height minus 45px removes the text and vector flower mark cleanly.
    const cropHeight = Math.max(100, (metadata.height || 1024) - 45);
    const cleanBuffer = await sharp(rawBuffer)
      .extract({
        left: 0,
        top: 0,
        width: metadata.width || 1024,
        height: cropHeight,
      })
      .jpeg({ quality: 95 })
      .toBuffer();

    return {
      buffer: cleanBuffer,
      mimeType: 'image/jpeg',
      prompt: cleanPrompt,
      fallbackUrl: imageUrl,
    };
  } catch {
    return null;
  }
}
