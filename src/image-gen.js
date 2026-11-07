/**
 * AI Image Generation Module for WhatsApp Assistant
 * Generates high-quality images from text prompts using Generative AI.
 */

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
