import { config } from './config.js';
import { privacyLog } from './privacy.js';

/**
 * Splits text into natural speech chunks under 200 characters for TTS generation.
 * @param {string} text
 * @returns {string[]}
 */
export function splitTextForSpeech(text) {
  if (!text || typeof text !== 'string') return [];

  // Strip WhatsApp markdown formatting for clean, natural speech synthesis
  const clean = text
    .replace(/\*([^*]+)\*/g, '$1') // *bold*
    .replace(/_([^_]+)_/g, '$1') // _italic_
    .replace(/~([^~]+)~/g, '$1') // ~strikethrough~
    .replace(/```[\s\S]*?```/g, 'Code block omitted for speech.') // code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // markdown links
    .replace(/[•\-*]\s+/g, '') // bullet points
    .replace(/\s+/g, ' ')
    .trim();

  // If text is very long, summarize/truncate to first ~400 characters for comfortable voice listening
  const speechText =
    clean.length > 500 ? clean.slice(0, 480) + '... Check the text message for the full details.' : clean;

  // Split at sentence boundaries or commas
  const sentences = speechText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [speechText];
  const chunks = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length <= 180) {
      if (trimmed.length > 0) chunks.push(trimmed);
    } else {
      // Split large sentence at commas or spaces
      const words = trimmed.split(' ');
      let current = '';
      for (const word of words) {
        if ((current + ' ' + word).trim().length > 180) {
          if (current.trim().length > 0) chunks.push(current.trim());
          current = word;
        } else {
          current = current ? current + ' ' + word : word;
        }
      }
      if (current.trim().length > 0) chunks.push(current.trim());
    }
  }

  return chunks;
}

/**
 * Synthesizes text into an MP3 audio buffer in-memory using lightweight TTS.
 * Zero disk writes (volatile RAM only).
 *
 * @param {string} text
 * @param {string} [lang='en']
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, mimeType?: string, reason?: string }>}
 */
export async function synthesizeSpeech(text, lang = 'en', options = {}) {
  if (options.mockBuffer) {
    return {
      ok: true,
      buffer: options.mockBuffer,
      mimeType: 'audio/mpeg',
    };
  }

  const chunks = splitTextForSpeech(text);
  if (chunks.length === 0) {
    return { ok: false, reason: 'empty_text' };
  }

  try {
    const audioBuffers = [];

    for (const chunk of chunks) {
      const encoded = encodeURIComponent(chunk);
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;

      const signal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
      const res = await fetch(ttsUrl, {
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        },
      });

      if (!res.ok) {
        privacyLog('warn', 'TTS_FETCH_FAILED', { status: res.status });
        return { ok: false, reason: `http_${res.status}` };
      }

      const arrayBuf = await res.arrayBuffer();
      audioBuffers.push(Buffer.from(arrayBuf));
    }

    const combinedBuffer = Buffer.concat(audioBuffers);
    return {
      ok: true,
      buffer: combinedBuffer,
      mimeType: 'audio/mpeg',
    };
  } catch (err) {
    const isTimeout =
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      (err.message && err.message.toLowerCase().includes('timeout'));

    privacyLog('error', 'TTS_SYNTHESIS_ERROR', { reason: isTimeout ? 'timeout' : err.message });
    return { ok: false, reason: isTimeout ? 'timeout' : 'error' };
  }
}
