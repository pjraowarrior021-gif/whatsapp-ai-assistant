import { URL } from 'node:url';
import { config } from './config.js';
import { privacyLog } from './privacy.js';

/**
 * URL matching regular expression (HTTP and HTTPS only).
 */
const URL_REGEX = /https?:\/\/[^\s<>"'()]+/i;

/**
 * Extracts the first valid HTTP/HTTPS URL from a text string.
 * @param {string} text
 * @returns {string | null}
 */
export function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(URL_REGEX);
  return match ? match[0] : null;
}

/**
 * Evaluates whether a target URL is safe to fetch (strict SSRF protection).
 * Blocks loopback, private RFC-1918 subnets, link-local, and local domains.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
export function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost and local names
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]'
    ) {
      return false;
    }

    // Block IPv4 private & link-local ranges
    // 127.0.0.0/8 (Loopback)
    // 10.0.0.0/8 (Private)
    // 192.168.0.0/16 (Private)
    // 172.16.0.0/12 (Private: 172.16 - 172.31)
    // 169.254.0.0/16 (Link-Local / Cloud Metadata e.g. AWS 169.254.169.254)
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const ipMatch = hostname.match(ipv4Regex);
    if (ipMatch) {
      const [o1, o2] = [parseInt(ipMatch[1], 10), parseInt(ipMatch[2], 10)];
      if (o1 === 127) return false;
      if (o1 === 10) return false;
      if (o1 === 192 && o2 === 168) return false;
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return false;
      if (o1 === 169 && o2 === 254) return false;
      if (o1 === 0) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Strips HTML markup, scripts, and clutter, returning clean page title and body text.
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export function cleanHtml(html) {
  if (!html || typeof html !== 'string') return { title: '', text: '' };

  // 1. Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : '';
  if (title) {
    title = title
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  // 2. Remove script and style elements
  let clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  clean = clean.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  clean = clean.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  clean = clean.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ');

  // 3. Remove navigational and footer elements
  clean = clean.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  clean = clean.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ');
  clean = clean.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ');

  // 4. Strip all remaining HTML tags
  clean = clean.replace(/<[^>]+>/g, ' ');

  // 5. Decode common HTML entities
  clean = clean
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // 6. Normalize whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  title = title.replace(/\s+/g, ' ').trim();

  // Bound text length to 15,000 characters to prevent prompt bloat
  const truncatedText = clean.length > 15000 ? clean.slice(0, 15000) + '...' : clean;

  return {
    title,
    text: truncatedText,
  };
}

/**
 * Fetches webpage in-memory and extracts clean article text.
 * Enforces timeout and size caps.
 *
 * @param {string} urlString
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, title?: string, text?: string, url?: string, reason?: string }>}
 */
export async function fetchAndExtractArticle(urlString, options = {}) {
  const url = extractUrl(urlString);
  if (!url) {
    return { ok: false, reason: 'invalid_url' };
  }

  if (!isSafeUrl(url)) {
    privacyLog('warn', 'SSRF_ATTEMPT_BLOCKED', { host: new URL(url).hostname });
    return { ok: false, reason: 'ssrf_blocked' };
  }

  try {
    let rawHtml;
    if (options.mockHtml) {
      rawHtml = options.mockHtml;
    } else {
      const signal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WhatsAppAssistant/1.0; +https://github.com)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });

      if (!res.ok) {
        return { ok: false, reason: `http_${res.status}` };
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return { ok: false, reason: 'unsupported_content_type' };
      }

      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (contentLength > config.MEDIA_MAX_BYTES) {
        return { ok: false, reason: 'too_large' };
      }

      if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of res.body) {
          totalBytes += chunk.length;
          if (totalBytes > config.MEDIA_MAX_BYTES) {
            return { ok: false, reason: 'too_large' };
          }
          chunks.push(Buffer.from(chunk));
        }
        rawHtml = Buffer.concat(chunks).toString('utf-8');
      } else if (typeof res.text === 'function') {
        rawHtml = await res.text();
      } else {
        return { ok: false, reason: 'unreadable_body' };
      }
    }

    const { title, text } = cleanHtml(rawHtml);
    if (!text || text.length < 50) {
      return { ok: false, reason: 'content_too_short' };
    }

    return {
      ok: true,
      title: title || url,
      text,
      url,
    };
  } catch (err) {
    const isTimeout =
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      (err.message && err.message.toLowerCase().includes('timeout'));

    return { ok: false, reason: isTimeout ? 'timeout' : 'network_error' };
  }
}
