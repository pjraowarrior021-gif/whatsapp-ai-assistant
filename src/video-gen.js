/**
 * Generative Video Module for WhatsApp AI Assistant
 * Provides text-to-video generation, animation prompts, and motion video synthesis.
 * Uses Gemini AI prompt direction paired with high-performance video generation.
 * Enforces strict volatile in-memory streaming with zero permanent disk writes.
 */
import { config } from './config.js';
import { enhanceVideoPrompt } from './gemini.js';
import { generateCleanImage } from './image-gen.js';
import { privacyLog } from './privacy.js';

/**
 * Minimal valid MP4 binary container fixture for hermetic unit testing and offline simulation.
 * Contains ftyp (isom/iso2/mp41) and moov atom structures.
 */
export const MOCK_MP4_BUFFER = Buffer.from([
  0x00,
  0x00,
  0x00,
  0x20,
  0x66,
  0x74,
  0x79,
  0x70, // ftyp atom size (32 bytes)
  0x69,
  0x73,
  0x6f,
  0x6d,
  0x00,
  0x00,
  0x02,
  0x00, // major_brand: isom, minor_version: 512
  0x69,
  0x73,
  0x6f,
  0x6d,
  0x69,
  0x73,
  0x6f,
  0x32, // compatible brands: isom, iso2
  0x61,
  0x76,
  0x63,
  0x31,
  0x6d,
  0x70,
  0x34,
  0x31, // avc1, mp41
  0x00,
  0x00,
  0x00,
  0x08,
  0x6d,
  0x6f,
  0x6f,
  0x76, // moov container atom (8 bytes)
]);

/**
 * Parses user input to detect if it is a video generation request.
 * Supports explicit slash commands (/video, /vid, /animate, /motion, /reel)
 * and natural language queries ("generate a video of...", "make an animation showing...").
 *
 * @param {string} text - Raw user message
 * @returns {string | null} Extracted video prompt, or null if not a video request
 */
export function parseVideoPrompt(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Explicit slash commands
  const slashMatch = trimmed.match(/^\/(?:video|vid|animate|motion|reel)\s+(.+)$/i);
  if (slashMatch) {
    return slashMatch[1].trim();
  }

  // 2. Natural language triggers (e.g. "generate a video of a futuristic drone race")
  const nlMatch = trimmed.match(
    /^(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|make|render|produce)\s+(?:an?\s+)?(?:video|animation|clip|short film|motion clip|reel)\s+(?:of|showing|about|depicting|with)?\s*(.+)$/i
  );
  if (nlMatch) {
    return nlMatch[1].trim();
  }

  // 3. "animate me a ..." or "make me a video of ..."
  const animateMatch = trimmed.match(
    /^(?:please\s+)?(?:can\s+you\s+)?(?:animate|make a video of)\s+(?:me\s+)?(?:an?\s+)?(.+)$/i
  );
  if (animateMatch) {
    return animateMatch[1].trim();
  }

  return null;
}

/**
 * Parses advanced flags and options from a raw video prompt string.
 * Supports aspect ratio (--wide, --vertical, --square), duration (--5s, --10s),
 * camera motion presets (--drone, --pan, --zoom, --orbit, --timelapse), and styles.
 *
 * @param {string} rawPrompt
 * @returns {{
 *   prompt: string,
 *   width: number,
 *   height: number,
 *   duration: number,
 *   motion: string | null,
 *   style: string | null,
 *   enhance: boolean
 * }}
 */
export function parseVideoPromptOptions(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== 'string') {
    return {
      prompt: '',
      width: 960,
      height: 540,
      duration: 5,
      motion: null,
      style: null,
      enhance: true,
    };
  }

  let text = rawPrompt.trim();
  let width = 960;
  let height = 540;
  let duration = 5;
  let motion = null;
  let style = null;
  let enhance = true;

  // 1. Aspect ratio / dimension flags
  if (/(?:^|\s+)--(?:vertical|story|reel|portrait)\b/i.test(text) || /(?:^|\s+)--ar\s+9:16\b/i.test(text)) {
    width = 540;
    height = 960;
    text = text
      .replace(/(?:^|\s+)--(?:vertical|story|reel|portrait)\b/gi, ' ')
      .replace(/(?:^|\s+)--ar\s+9:16\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:wide|landscape|horizontal)\b/i.test(text) || /(?:^|\s+)--ar\s+16:9\b/i.test(text)) {
    width = 960;
    height = 540;
    text = text.replace(/(?:^|\s+)--(?:wide|landscape|horizontal)\b/gi, ' ').replace(/(?:^|\s+)--ar\s+16:9\b/gi, ' ');
  } else if (/(?:^|\s+)--square\b/i.test(text) || /(?:^|\s+)--ar\s+1:1\b/i.test(text)) {
    width = 576;
    height = 576;
    text = text.replace(/(?:^|\s+)--square\b/gi, ' ').replace(/(?:^|\s+)--ar\s+1:1\b/gi, ' ');
  }

  // 2. Duration flags (--5s, --10s, -d 5, -d 10)
  if (/(?:^|\s+)--(?:10s|ten)\b/i.test(text) || /(?:^|\s+)-d\s+10\b/i.test(text)) {
    duration = 10;
    text = text.replace(/(?:^|\s+)--(?:10s|ten)\b/gi, ' ').replace(/(?:^|\s+)-d\s+10\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:5s|five)\b/i.test(text) || /(?:^|\s+)-d\s+5\b/i.test(text)) {
    duration = 5;
    text = text.replace(/(?:^|\s+)--(?:5s|five)\b/gi, ' ').replace(/(?:^|\s+)-d\s+5\b/gi, ' ');
  }

  // 3. Camera motion dynamics
  if (/(?:^|\s+)--drone\b/i.test(text)) {
    motion = 'drone flyover';
    text = text.replace(/(?:^|\s+)--drone\b/gi, ' ');
  } else if (/(?:^|\s+)--pan\b/i.test(text)) {
    motion = 'horizontal pan';
    text = text.replace(/(?:^|\s+)--pan\b/gi, ' ');
  } else if (/(?:^|\s+)--zoom\b/i.test(text)) {
    motion = 'slow cinematic push-in zoom';
    text = text.replace(/(?:^|\s+)--zoom\b/gi, ' ');
  } else if (/(?:^|\s+)--orbit\b/i.test(text)) {
    motion = 'orbital camera rotation';
    text = text.replace(/(?:^|\s+)--orbit\b/gi, ' ');
  } else if (/(?:^|\s+)--timelapse\b/i.test(text)) {
    motion = 'high-speed time-lapse';
    text = text.replace(/(?:^|\s+)--timelapse\b/gi, ' ');
  } else if (/(?:^|\s+)--slowmo\b/i.test(text)) {
    motion = 'slow motion 120fps';
    text = text.replace(/(?:^|\s+)--slowmo\b/gi, ' ');
  }

  // 4. Raw flag
  if (/(?:^|\s+)--raw\b/i.test(text)) {
    enhance = false;
    text = text.replace(/(?:^|\s+)--raw\b/gi, ' ');
  }

  // 5. Style presets
  if (/(?:^|\s+)--(?:anime|manga)\b/i.test(text)) {
    style = 'anime';
    text = text.replace(/(?:^|\s+)--(?:anime|manga)\b/gi, ' ');
  } else if (/(?:^|\s+)--(?:photo|real|realistic)\b/i.test(text)) {
    style = 'cinematic realism';
    text = text.replace(/(?:^|\s+)--(?:photo|real|realistic)\b/gi, ' ');
  } else if (/(?:^|\s+)--cyberpunk\b/i.test(text)) {
    style = 'cyberpunk neon';
    text = text.replace(/(?:^|\s+)--cyberpunk\b/gi, ' ');
  } else if (/(?:^|\s+)--3d\b/i.test(text)) {
    style = '3D CGI animation';
    text = text.replace(/(?:^|\s+)--3d\b/gi, ' ');
  } else if (/(?:^|\s+)--cinematic\b/i.test(text)) {
    style = 'cinematic movie shot';
    text = text.replace(/(?:^|\s+)--cinematic\b/gi, ' ');
  }

  text = text.replace(/\s{2,}/g, ' ').trim();

  return {
    prompt: text,
    width,
    height,
    duration,
    motion,
    style,
    enhance,
  };
}

/**
 * Builds video generation request URL with prompt and parameter options.
 *
 * @param {string} prompt - Cleaned prompt
 * @param {object} options
 * @returns {string} URL endpoint
 */
export function buildVideoUrl(prompt, options = {}) {
  const cleanPrompt = String(prompt).trim();
  const encoded = encodeURIComponent(cleanPrompt);
  const width = options.width || 960;
  const height = options.height || 540;
  const duration = options.duration || 5;

  return `https://gen.pollinations.ai/video/${encoded}?width=${width}&height=${height}&duration=${duration}`;
}

/**
 * Generates an AI video from a text prompt in volatile memory.
 * Employs Gemini Video Prompt Engineer to enhance cinematography and motion trajectory.
 * Incorporates bounded timeouts (45s) and automatic visual fallback to concept still image
 * if external cloud video APIs are rate-limited or unavailable.
 *
 * @param {string} rawPrompt - User video prompt
 * @param {object} [userOptions] - Override options
 * @returns {Promise<{
 *   ok: boolean,
 *   buffer?: Buffer,
 *   mimeType?: string,
 *   prompt: string,
 *   enhancedPrompt: string,
 *   width: number,
 *   height: number,
 *   duration: number,
 *   fallbackImage?: object,
 *   reason?: string
 * }>}
 */
export async function generateVideo(rawPrompt, userOptions = {}) {
  const parsed = parseVideoPromptOptions(rawPrompt);
  const options = {
    width: userOptions.width || parsed.width || 960,
    height: userOptions.height || parsed.height || 540,
    duration: userOptions.duration || parsed.duration || 5,
    motion: userOptions.motion || parsed.motion,
    style: userOptions.style || parsed.style,
    enhance: userOptions.enhance !== undefined ? userOptions.enhance : parsed.enhance,
    mockBuffer: userOptions.mockBuffer,
    mock: userOptions.mock,
  };

  let effectivePrompt = parsed.prompt || String(rawPrompt).trim();
  if (options.style) {
    effectivePrompt += `, ${options.style}`;
  }
  if (options.motion) {
    effectivePrompt += `, ${options.motion}`;
  }

  // Hermetic testing & offline simulation bypass
  if (options.mockBuffer) {
    return {
      ok: true,
      buffer: options.mockBuffer,
      mimeType: 'video/mp4',
      prompt: parsed.prompt,
      enhancedPrompt: effectivePrompt,
      width: options.width,
      height: options.height,
      duration: options.duration,
    };
  }

  // During automated unit tests or mock mode, return valid mock MP4 buffer
  if ((config.NODE_ENV === 'test' || options.mock) && !userOptions.allowLiveNetwork) {
    return {
      ok: true,
      buffer: MOCK_MP4_BUFFER,
      mimeType: 'video/mp4',
      prompt: parsed.prompt,
      enhancedPrompt: effectivePrompt,
      width: options.width,
      height: options.height,
      duration: options.duration,
    };
  }

  // Enhance video prompt with Gemini AI director
  let finalPrompt = effectivePrompt;
  if (options.enhance && effectivePrompt.length < 250) {
    try {
      finalPrompt = await enhanceVideoPrompt(effectivePrompt, options.motion);
    } catch {
      finalPrompt = effectivePrompt;
    }
  }

  const videoUrl = buildVideoUrl(finalPrompt, options);

  try {
    // 45s bounded timeout to prevent queue worker starvation
    const signal = AbortSignal.timeout(45000);
    const headers = {};
    if (process.env.POLLINATIONS_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.POLLINATIONS_API_KEY}`;
    }

    const res = await fetch(videoUrl, { signal, headers });
    if (!res.ok) {
      privacyLog('warn', 'VIDEO_API_RESPONSE_NOT_OK', { status: res.status });
      // Generate immediate high-definition visual concept still image as fallback
      const fallbackImage = await generateCleanImage(finalPrompt, {
        width: options.width > options.height ? 1280 : 720,
        height: options.width > options.height ? 720 : 1280,
      });
      return {
        ok: false,
        prompt: parsed.prompt,
        enhancedPrompt: finalPrompt,
        width: options.width,
        height: options.height,
        duration: options.duration,
        fallbackImage,
        reason: `Video API returned status ${res.status}`,
      };
    }

    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    // WhatsApp video cap: 16MB
    if (contentLength > 16 * 1024 * 1024) {
      return {
        ok: false,
        prompt: parsed.prompt,
        enhancedPrompt: finalPrompt,
        width: options.width,
        height: options.height,
        duration: options.duration,
        reason: 'video_too_large',
      };
    }

    const chunks = [];
    let totalBytes = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        totalBytes += chunk.length;
        if (totalBytes > 16 * 1024 * 1024) {
          return {
            ok: false,
            prompt: parsed.prompt,
            enhancedPrompt: finalPrompt,
            width: options.width,
            height: options.height,
            duration: options.duration,
            reason: 'video_too_large',
          };
        }
        chunks.push(Buffer.from(chunk));
      }
    }

    const videoBuffer = Buffer.concat(chunks);
    if (videoBuffer.length < 100) {
      return {
        ok: false,
        prompt: parsed.prompt,
        enhancedPrompt: finalPrompt,
        width: options.width,
        height: options.height,
        duration: options.duration,
        reason: 'empty_video_payload',
      };
    }

    return {
      ok: true,
      buffer: videoBuffer,
      mimeType: 'video/mp4',
      prompt: parsed.prompt,
      enhancedPrompt: finalPrompt,
      width: options.width,
      height: options.height,
      duration: options.duration,
    };
  } catch (err) {
    privacyLog('warn', 'VIDEO_GENERATION_FAILED', { error: err.message });
    // Generate concept still image fallback on timeout or connection drop
    const fallbackImage = await generateCleanImage(finalPrompt, {
      width: options.width > options.height ? 1280 : 720,
      height: options.width > options.height ? 720 : 1280,
    });
    return {
      ok: false,
      prompt: parsed.prompt,
      enhancedPrompt: finalPrompt,
      width: options.width,
      height: options.height,
      duration: options.duration,
      fallbackImage,
      reason: err.name === 'TimeoutError' ? 'generation_timeout' : err.message,
    };
  }
}
