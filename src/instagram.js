/**
 * Instagram Reel & Post Intelligence Module
 * Ingests Open Graph metadata and captions from Instagram Reels and Posts
 * via official social crawler user-agents, formatting structured briefs for Gemini AI.
 */
import { URL } from 'node:url';
import { config } from './config.js';
import { extractUrl, isSafeUrl, decodeHtmlEntities } from './web-scraper.js';
import { privacyLog } from './privacy.js';

/**
 * Validates whether an input string contains a valid Instagram Reel or Post link.
 * Strictly verifies the domain to protect against spoofing (e.g. instagram.com.attacker.com).
 *
 * @param {string} input - Text containing an Instagram URL or raw URL string
 * @returns {boolean}
 */
export function isInstagramUrl(input) {
  if (!input || typeof input !== 'string') return false;
  const rawUrl = extractUrl(input);
  if (!rawUrl) return false;

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isIgHost =
      host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'instagr.am' ||
      host.endsWith('.instagr.am');

    if (!isIgHost) return false;

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return false;

    // Handles /reel/SHORTCODE, /p/SHORTCODE, /reels/SHORTCODE, /tv/SHORTCODE, /share/reel/SHORTCODE, etc.
    const validSegments = new Set(['reel', 'reels', 'p', 'tv', 'share']);
    return validSegments.has(parts[0]);
  } catch {
    return false;
  }
}

/**
 * Extracts the alphanumeric Instagram shortcode from a Reel or Post URL.
 *
 * @param {string} input
 * @returns {string | null}
 */
export function extractInstagramShortcode(input) {
  if (!input || typeof input !== 'string') return null;
  const rawUrl = extractUrl(input);
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isIgHost =
      host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'instagr.am' ||
      host.endsWith('.instagr.am');

    if (!isIgHost) return null;

    const parts = parsed.pathname.split('/').filter(Boolean);
    // /share/reel/SHORTCODE or /share/p/SHORTCODE
    if (parts[0] === 'share' && (parts[1] === 'reel' || parts[1] === 'p') && parts[2]) {
      return parts[2];
    }

    // /reel/SHORTCODE, /p/SHORTCODE, /reels/SHORTCODE, /tv/SHORTCODE
    if ((parts[0] === 'reel' || parts[0] === 'reels' || parts[0] === 'p' || parts[0] === 'tv') && parts[1]) {
      return parts[1];
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Parses author handle and clean caption from Instagram Open Graph description and title.
 *
 * @param {string} ogTitle
 * @param {string} ogDesc
 * @returns {{ author: string, caption: string }}
 */
export function parseInstagramMetadata(ogTitle = '', ogDesc = '') {
  let author = '';
  let caption = '';

  // 1. Check title pattern: "Name (@handle) on Instagram: '...'" or "Name on Instagram: '...'"
  const titleAuthorMatch = ogTitle.match(/^(?:([^\n\r]+?)\s+on\s+Instagram:)/i);
  if (titleAuthorMatch) {
    author = titleAuthorMatch[1].replace(/["']/g, '').trim();
  }

  // 2. Check description footer pattern: "- @handle on Month Day, Year"
  const descAuthorMatch = ogDesc.match(/-\s*(@[a-zA-Z0-9._]+)\s+on\s+[A-Za-z]+\s+\d+/i);
  if (descAuthorMatch && !author) {
    author = descAuthorMatch[1];
  }

  // 3. Extract caption text, preferring the longer of og:description or og:title body
  if (ogDesc) {
    // Strip trailing author date stamp if present
    caption = ogDesc.replace(/-\s*@[a-zA-Z0-9._]+\s+on\s+[A-Za-z]+\s+\d+.*$/i, '').trim();
  }

  if (!caption && ogTitle) {
    const bodyMatch = ogTitle.match(/on\s+Instagram:\s*["']([\s\S]*?)["']?$/i);
    if (bodyMatch) {
      caption = bodyMatch[1].trim();
    } else {
      caption = ogTitle;
    }
  }

  return { author, caption };
}

/**
 * Fetches Instagram Reel or Post metadata via social crawler Open Graph headers.
 * Never requires user login or Instagram API tokens.
 *
 * @param {string} urlString
 * @param {object} [options]
 * @param {Function} [options.fetcher]
 * @returns {Promise<{
 *   ok: boolean,
 *   url: string,
 *   shortcode?: string,
 *   isReel: boolean,
 *   title: string,
 *   caption: string,
 *   author: string,
 *   reason?: string
 * }>}
 */
export async function fetchInstagramPostData(urlString, options = {}) {
  const url = extractUrl(urlString);
  if (!url) {
    return { ok: false, reason: 'invalid_url', isReel: false, url: '', title: '', caption: '', author: '' };
  }

  if (!isSafeUrl(url)) {
    privacyLog('warn', 'SSRF_ATTEMPT_BLOCKED', { host: new URL(url).hostname });
    return { ok: false, reason: 'ssrf_blocked', isReel: false, url, title: '', caption: '', author: '' };
  }

  const shortcode = extractInstagramShortcode(url);
  const isReel = url.includes('/reel/') || url.includes('/reels/');
  const canonicalUrl = shortcode ? `https://www.instagram.com/reel/${shortcode}/` : url;

  try {
    let rawHtml = '';
    if (options.mockHtml) {
      rawHtml = options.mockHtml;
    } else {
      const fetcher = options.fetcher || globalThis.fetch;
      const signal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
      const res = await fetcher(url, {
        signal,
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php) WhatsApp/2.23.23.77',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!res.ok) {
        privacyLog('warn', 'INSTAGRAM_FETCH_HTTP_ERROR', { status: res.status });
        // Return ok: true with fallback to allow Google Search Grounding to summarize the Reel
        return {
          ok: true,
          url: canonicalUrl,
          shortcode: shortcode || undefined,
          isReel,
          title: isReel ? 'Instagram Reel' : 'Instagram Post',
          caption: '',
          author: 'Instagram Creator',
          reason: `http_${res.status}`,
        };
      }

      rawHtml = await res.text();
    }

    // Extract Open Graph title
    const titleMatch =
      rawHtml.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([\s\S]*?)["']/i) ||
      rawHtml.match(/<meta\s+content=["']([\s\S]*?)["']\s+(?:property|name)=["']og:title["']/i);

    // Extract Open Graph description
    const descMatch =
      rawHtml.match(/<meta\s+(?:property|name)=["'](?:og:description|description)["']\s+content=["']([\s\S]*?)["']/i) ||
      rawHtml.match(/<meta\s+content=["']([\s\S]*?)["']\s+(?:property|name)=["'](?:og:description|description)["']/i);

    const rawTitle = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';
    const rawDesc = descMatch ? decodeHtmlEntities(descMatch[1].trim()) : '';

    const { author, caption } = parseInstagramMetadata(rawTitle, rawDesc);

    privacyLog('info', 'INSTAGRAM_DATA_EXTRACTED', {
      isReel,
      hasCaption: Boolean(caption),
      captionLength: caption ? caption.length : 0,
      hasAuthor: Boolean(author),
    });

    return {
      ok: true,
      url: canonicalUrl,
      shortcode: shortcode || undefined,
      isReel,
      title: rawTitle || (isReel ? 'Instagram Reel' : 'Instagram Post'),
      caption: caption || rawDesc || rawTitle,
      author: author || 'Instagram Creator',
    };
  } catch (err) {
    const isTimeout =
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      (err.message && err.message.toLowerCase().includes('timeout'));

    privacyLog('warn', 'INSTAGRAM_FETCH_EXCEPTION', { isTimeout, error: err.message });

    // Fallback: Return ok: true with minimal metadata so Gemini grounds via Google Search
    return {
      ok: true,
      url: canonicalUrl,
      shortcode: shortcode || undefined,
      isReel,
      title: isReel ? 'Instagram Reel' : 'Instagram Post',
      caption: '',
      author: 'Instagram Creator',
      reason: isTimeout ? 'timeout' : 'network_error',
    };
  }
}

/**
 * Builds the AI prompt for Gemini to summarize an Instagram Reel or Post.
 *
 * @param {object} instaData - Result of fetchInstagramPostData
 * @param {string} [userQuestion=''] - Optional user prompt or specific question
 * @returns {string}
 */
export function buildInstagramAiPrompt(instaData, userQuestion = '') {
  const { title, author, caption, url, isReel } = instaData;
  const userAside = userQuestion ? `\n\nUser Question/Instruction: "${userQuestion}"` : '';
  const mediaLabel = isReel ? 'Instagram Reel' : 'Instagram Post';

  if (caption && caption.length > 20) {
    return [
      `The user shared this ${mediaLabel}: [${title || mediaLabel}](${url}) by ${author}.${userAside}`,
      '',
      'Post Details & Caption:',
      '"""',
      caption,
      '"""',
      '',
      `Provide a lively, clear, and high-impact summary of this ${mediaLabel} formatted cleanly for WhatsApp:`,
      '1. 📍 *Venue / Main Subject* (Name, location/city, and vibe or concept)',
      '2. 🍽️ / 🎥 *Highlights & Key Details* (Must-try items, key recommendations, pricing, or special features mentioned)',
      '3. 👤 *Creator / Source* (Creator handle and context)',
      '4. 💡 *Verdict & Recommendation* (Who should visit/check this out)',
    ].join('\n');
  }

  return [
    `The user shared this ${mediaLabel} link: [${title || mediaLabel}](${url}) by ${author}.${userAside}`,
    '',
    'Note: Direct caption text was not publicly available for this link.',
    'Use Google Search to find details about this Instagram post, creator, venue, and subject.',
    'Provide a helpful, structured overview of what this post covers, highlighting any known locations, reviews, or key takeaways.',
  ].join('\n');
}
