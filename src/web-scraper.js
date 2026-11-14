import { URL } from 'node:url';
import crypto from 'node:crypto';
import { config } from './config.js';
import { privacyLog, isDomainInAllowlist } from './privacy.js';
import { store } from './store/index.js';

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
 * Strips all occurrences of a URL and redundant preview header/footer lines (e.g. "www.youtube.com")
 * leaving only the user's actual question, instruction, or prompt text.
 *
 * @param {string} text
 * @param {string} [url]
 * @returns {string}
 */
export function extractUserPromptAside(text, url) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  if (url) {
    cleaned = cleaned.replaceAll(url, '');
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hostRegex = new RegExp(`^\\s*${escapedHost}\\s*$`, 'gim');
      cleaned = cleaned.replace(hostRegex, '');
    } catch {
      // ignore parsing error
    }
  }
  return cleaned.trim();
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
 * Decodes all HTML entities including named, decimal, and hexadecimal unicode entities.
 * @param {string} str
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#064;/gi, '@')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return '';
      }
    });
}

/**
 * Strips HTML markup, scripts, and clutter, returning clean page title and body text.
 * Also extracts Open Graph and meta descriptions for Single Page Apps and social previews.
 * @param {string} html
 * @returns {{ title: string, text: string, metaDescription?: string }}
 */
export function cleanHtml(html) {
  if (!html || typeof html !== 'string') return { title: '', text: '' };

  // 1. Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  // 1b. Extract Open Graph & Meta tags (og:title, og:description, meta description, twitter:description)
  const ogTitleMatch =
    html.match(/<meta\s+(?:property|name)=["'](?:og:title|twitter:title)["']\s+content=["']([\s\S]*?)["']/i) ||
    html.match(/<meta\s+content=["']([\s\S]*?)["']\s+(?:property|name)=["'](?:og:title|twitter:title)["']/i);
  if (ogTitleMatch) {
    const ogTitle = decodeHtmlEntities(ogTitleMatch[1].trim());
    if (!title || (ogTitle && ogTitle.length > title.length)) {
      title = ogTitle;
    }
  }

  const metaDescMatch =
    html.match(
      /<meta\s+(?:property|name)=["'](?:og:description|description|twitter:description)["']\s+content=["']([\s\S]*?)["']/i
    ) ||
    html.match(
      /<meta\s+content=["']([\s\S]*?)["']\s+(?:property|name)=["'](?:og:description|description|twitter:description)["']/i
    );
  const metaDescription = metaDescMatch ? decodeHtmlEntities(metaDescMatch[1].trim()) : '';

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
  clean = decodeHtmlEntities(clean);

  // 6. Normalize whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  title = title.replace(/\s+/g, ' ').trim();

  // If visible body text is very short (< 50 chars) but meta description exists, use meta description!
  if ((!clean || clean.length < 50) && metaDescription && metaDescription.length >= 20) {
    clean = metaDescription;
  }

  // Bound text length to 15,000 characters to prevent prompt bloat
  const truncatedText = clean.length > 15000 ? clean.slice(0, 15000) + '...' : clean;

  return {
    title,
    text: truncatedText,
    metaDescription,
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
      const defaultUa =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (WhatsAppAssistant/1.0; +https://github.com/pjraowarrior021-gif/whatsapp-ai-assistant)';
      let res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': defaultUa,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      // If blocked with 403, retry with social crawler User-Agent as fallback
      if (res.status === 403) {
        res = await fetch(url, {
          signal,
          headers: {
            'User-Agent':
              'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php) WhatsApp/2.23.23.77',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
      }

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

    const { title, text, metaDescription } = cleanHtml(rawHtml);
    if (!text || text.length < 50) {
      if (title && title.length > 3) {
        return {
          ok: true,
          title,
          text: metaDescription || title,
          url,
          needsGrounding: true,
        };
      }
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

/**
 * Computes a SHA-256 hash of text content for change detection and deduplication.
 * @param {string} text
 * @returns {string}
 */
export function computeContentHash(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || ''), 'utf8')
    .digest('hex');
}

const WATCHLIST_STORE_KEY = 'web_learn:watchlist';

/**
 * Retrieves the vetted watchlist from persistent store.
 * @returns {Promise<Array<object>>}
 */
export async function getWatchlist() {
  const raw = await store.get(WATCHLIST_STORE_KEY);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Adds or updates a target in the vetted watchlist.
 *
 * @param {object} item
 * @param {string} item.target - URL, domain, or research topic
 * @param {'url'|'domain'|'topic'} [item.type='url']
 * @param {number} [item.intervalSec=21600] - Ingestion interval (default: 6 hours)
 * @param {number} [item.ttlSec=604800] - Freshness TTL (default: 7 days)
 * @returns {Promise<{ success: boolean, item?: object, error?: string }>}
 */
export async function addToWatchlist({ target, type = 'url', intervalSec = 21600, ttlSec = 604800 }) {
  if (!target || typeof target !== 'string') {
    return { success: false, error: 'Target must be a non-empty string' };
  }

  const cleanTarget = target.trim();

  // Validate against vetted domain allowlist if URL or domain
  if (type === 'url' || type === 'domain' || cleanTarget.startsWith('http')) {
    if (!isDomainInAllowlist(cleanTarget)) {
      return {
        success: false,
        error: `Domain for "${cleanTarget}" is not on the vetted domain allowlist.`,
      };
    }
  }

  const list = await getWatchlist();
  const id = `wl_${crypto.createHash('md5').update(cleanTarget).digest('hex').slice(0, 10)}`;

  const existingIdx = list.findIndex((w) => w.id === id || w.target.toLowerCase() === cleanTarget.toLowerCase());
  const entry = {
    id,
    target: cleanTarget,
    type,
    enabled: true,
    intervalSec: Number(intervalSec) || 21600,
    ttlSec: Number(ttlSec) || 604800,
    addedAt: existingIdx >= 0 ? list[existingIdx].addedAt : Date.now(),
    lastScrapedAt: existingIdx >= 0 ? list[existingIdx].lastScrapedAt : null,
  };

  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...entry };
  } else {
    list.push(entry);
  }

  await store.set(WATCHLIST_STORE_KEY, JSON.stringify(list));
  privacyLog('info', 'WEB_LEARN_WATCHLIST_UPDATED', { target: cleanTarget, type });
  return { success: true, item: entry };
}

/**
 * Removes an item from the vetted watchlist.
 * @param {string} idOrTarget
 * @returns {Promise<{ success: boolean, removed: boolean }>}
 */
export async function removeFromWatchlist(idOrTarget) {
  if (!idOrTarget) return { success: false, removed: false };
  const list = await getWatchlist();
  const filtered = list.filter((w) => w.id !== idOrTarget && w.target.toLowerCase() !== idOrTarget.toLowerCase());
  const removed = filtered.length < list.length;
  if (removed) {
    await store.set(WATCHLIST_STORE_KEY, JSON.stringify(filtered));
  }
  return { success: true, removed };
}

/**
 * Clears all items from the watchlist (for test teardown).
 */
export async function clearWatchlist() {
  await store.del(WATCHLIST_STORE_KEY);
}
