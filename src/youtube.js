/**
 * YouTube Video Intelligence & Summarization Module
 * Fetches video metadata via oEmbed and subtitles/transcripts via timed-text tracks.
 * Prepares formatted chronological transcripts with timestamps for Gemini AI summarization.
 */
import { URL } from 'node:url';
import { YoutubeTranscript } from 'youtube-transcript';
import { config } from './config.js';
import { extractUrl } from './web-scraper.js';
import { privacyLog } from './privacy.js';

/**
 * Extracts a YouTube Video ID (11 characters) from a URL or text string.
 * Supports standard watch URLs, youtu.be, shorts, embeds, and mobile links.
 *
 * @param {string} input - Text containing a YouTube link or raw URL
 * @returns {string | null} 11-character video ID, or null if not a valid YouTube URL
 */
export function extractYouTubeVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const rawUrl = extractUrl(input);
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();

    // Standard youtube.com domains
    if (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'www.youtube-nocookie.com'
    ) {
      // 1. /watch?v=VIDEO_ID
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
        return v;
      }

      // 2. /shorts/VIDEO_ID, /embed/VIDEO_ID, /v/VIDEO_ID, /live/VIDEO_ID
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      if (
        (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'v' || pathParts[0] === 'live') &&
        pathParts[1]
      ) {
        const id = pathParts[1].substring(0, 11);
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
          return id;
        }
      }
    }

    // Shortened youtu.be domain
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      if (pathParts[0]) {
        const id = pathParts[0].substring(0, 11);
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
          return id;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Checks if a string contains a valid YouTube link.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isYouTubeUrl(text) {
  return Boolean(extractYouTubeVideoId(text));
}

/**
 * Checks if a URL or text points to a YouTube domain (regardless of whether video ID is valid).
 *
 * @param {string} input
 * @returns {boolean}
 */
export function isYouTubeDomain(input) {
  if (!input || typeof input !== 'string') return false;
  const rawUrl = extractUrl(input);
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'www.youtube-nocookie.com' ||
      host === 'youtu.be' ||
      host === 'www.youtu.be'
    );
  } catch {
    return false;
  }
}

/**
 * Formats a duration in seconds into a standard MM:SS or HH:MM:SS timestamp string.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatVideoTimestamp(totalSeconds) {
  const sec = Math.floor(totalSeconds || 0);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Fetches official YouTube video metadata via YouTube oEmbed service.
 * Requires zero API keys and avoids web scraping bot hurdles.
 *
 * @param {string} videoId
 * @returns {Promise<{ title: string, authorName: string, authorUrl: string, thumbnailUrl: string }>}
 */
export async function fetchYouTubeMetadata(videoId) {
  if (config.NODE_ENV === 'test') {
    return {
      title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
      authorName: 'Rick Astley',
      authorUrl: 'https://www.youtube.com/@RickAstleyYT',
      thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    };
  }

  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;

  try {
    const signal = AbortSignal.timeout(6000);
    const res = await fetch(oembedUrl, { signal });
    if (res.ok) {
      const data = await res.json();
      return {
        title: data.title || 'YouTube Video',
        authorName: data.author_name || 'YouTube Creator',
        authorUrl: data.author_url || '',
        thumbnailUrl: data.thumbnail_url || '',
      };
    }
  } catch (err) {
    privacyLog('warn', 'YOUTUBE_OEMBED_FAILED', { videoId, error: err.message });
  }

  return {
    title: 'YouTube Video',
    authorName: 'YouTube Creator',
    authorUrl: '',
    thumbnailUrl: '',
  };
}

/**
 * Formats raw transcript array items into clean, chronological paragraphs with timestamps.
 * Groups captions that occur within 60-second intervals into readable sections.
 *
 * @param {Array<{ text: string, offset: number, duration: number }>} transcriptItems
 * @param {number} [maxChars=24000] - Safety ceiling to prevent prompt context overflow
 * @returns {string}
 */
export function formatTranscript(transcriptItems = [], maxChars = 24000) {
  if (!Array.isArray(transcriptItems) || transcriptItems.length === 0) {
    return '';
  }

  const sections = [];
  let currentTimestamp = 0;
  let currentGroup = [];

  for (const item of transcriptItems) {
    const cleanText = (item.text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .trim();

    if (!cleanText || cleanText === '[Music]' || cleanText === '[Applause]') {
      continue;
    }

    const itemSec = Math.floor((item.offset || 0) / 1000);

    // Group entries in ~60-second time blocks for clarity and readability
    if (currentGroup.length === 0) {
      currentTimestamp = itemSec;
      currentGroup.push(cleanText);
    } else if (itemSec - currentTimestamp > 60) {
      sections.push(`[${formatVideoTimestamp(currentTimestamp)}] ${currentGroup.join(' ')}`);
      currentTimestamp = itemSec;
      currentGroup = [cleanText];
    } else {
      currentGroup.push(cleanText);
    }
  }

  if (currentGroup.length > 0) {
    sections.push(`[${formatVideoTimestamp(currentTimestamp)}] ${currentGroup.join(' ')}`);
  }

  let fullText = sections.join('\n\n');

  // Enforce safety ceiling
  if (fullText.length > maxChars) {
    fullText = fullText.slice(0, maxChars) + '\n\n...[Transcript truncated for length]...';
  }

  return fullText;
}

/**
 * Fetches transcript and metadata for a given YouTube video.
 * Handles both captioned videos and videos with captions disabled.
 *
 * @param {string} videoId
 * @param {object} [options]
 * @param {Function} [options.fetcher] - Dependency injection for testing/mocking
 * @returns {Promise<{
 *   ok: boolean,
 *   videoId: string,
 *   url: string,
 *   title: string,
 *   author: string,
 *   hasTranscript: boolean,
 *   transcriptText?: string,
 *   reason?: string,
 *   error?: string
 * }>}
 */
export async function fetchYouTubeVideoData(videoId, options = {}) {
  if (!videoId || typeof videoId !== 'string') {
    return { ok: false, reason: 'invalid_id' };
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const metadata = await fetchYouTubeMetadata(videoId);

  const defaultTestFetcher = async () => [
    { text: 'Never gonna give you up', offset: 0, duration: 2000 },
    { text: 'Never gonna let you down', offset: 2500, duration: 2500 },
  ];
  const fetcher =
    options.fetcher ||
    (config.NODE_ENV === 'test' ? defaultTestFetcher : (id, opt) => YoutubeTranscript.fetchTranscript(id, opt));

  try {
    let rawItems;
    try {
      // First try fetching English captions
      rawItems = await fetcher(videoId, { lang: 'en' });
    } catch {
      // If English fails or unavailable, fetch default/auto-generated captions
      rawItems = await fetcher(videoId);
    }

    if (Array.isArray(rawItems) && rawItems.length > 0) {
      const transcriptText = formatTranscript(rawItems);
      privacyLog('info', 'YOUTUBE_TRANSCRIPT_FETCHED', {
        videoId,
        itemCount: rawItems.length,
        transcriptLength: transcriptText.length,
      });

      return {
        ok: true,
        videoId,
        url: canonicalUrl,
        title: metadata.title,
        author: metadata.authorName,
        hasTranscript: true,
        transcriptText,
      };
    }

    return {
      ok: true,
      videoId,
      url: canonicalUrl,
      title: metadata.title,
      author: metadata.authorName,
      hasTranscript: false,
      reason: 'no_captions',
    };
  } catch (err) {
    const errMsg = err.message || String(err);
    const isNoTranscript =
      errMsg.includes('Could not find') ||
      errMsg.includes('disabled') ||
      errMsg.includes('unavailable') ||
      errMsg.includes('Transcript is disabled');

    privacyLog('warn', 'YOUTUBE_TRANSCRIPT_UNAVAILABLE', { videoId, error: errMsg });

    // Resilient fallback: instead of failing, return video metadata so Gemini can summarize via Google Search Grounding
    return {
      ok: true,
      videoId,
      url: canonicalUrl,
      title: metadata.title,
      author: metadata.authorName,
      hasTranscript: false,
      reason: isNoTranscript ? 'transcripts_disabled' : 'fetch_error_fallback',
      error: errMsg,
    };
  }
}

/**
 * Builds the AI summarization prompt for Gemini based on video metadata and transcript.
 *
 * @param {object} videoData - Result of fetchYouTubeVideoData
 * @param {string} [userQuestion=''] - Optional user prompt or specific question
 * @returns {string}
 */
export function buildYouTubeAiPrompt(videoData, userQuestion = '') {
  const { title, author, url, hasTranscript, transcriptText } = videoData;
  const userAside = userQuestion ? `\n\nUser Question/Instruction: "${userQuestion}"` : '';

  if (hasTranscript && transcriptText) {
    return [
      `The user shared this YouTube video: [${title}](${url}) by ${author}.${userAside}`,
      '',
      'Video Transcript (with timestamps):',
      '"""',
      transcriptText,
      '"""',
      '',
      'Provide a clear, high-impact YouTube video summary formatted cleanly for WhatsApp:',
      '1. 📌 *Core Thesis / Overview* (1-2 sentences summarizing the central point)',
      '2. 💡 *Key Takeaways & Insights* (3-5 comprehensive bullet points, preserving specific figures, facts, or code)',
      '3. ⏱️ *Key Topic Timestamps* (highlight 3-5 major milestone sections with their timestamps from the transcript)',
      '4. 🎯 *Conclusion / Recommendation* (who should watch this and why)',
    ].join('\n');
  }

  return [
    `The user shared this YouTube video link: [${title}](${url}) by ${author}.${userAside}`,
    '',
    'Note: Public captions and subtitles are disabled for this video, so a word-by-word transcript is unavailable.',
    'Please provide a helpful, structured overview of what this video and subject cover based on its title, creator/channel, and known domain knowledge.',
    'Highlight key topics the user can expect and recommend relevant resources or concepts.',
  ].join('\n');
}
