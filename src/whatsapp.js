import { config, normalizePhoneNumber } from './config.js';
import { privacyLog } from './privacy.js';

const WHATSAPP_API_BASE = 'https://graph.facebook.com';
const MAX_WHATSAPP_MESSAGE_LENGTH = 4000; // WhatsApp hard limit is 4096; safe margin at 4000

/**
 * Splits a long text response into message chunks that respect WhatsApp's character limits
 * without breaking code blocks or words abruptly.
 *
 * @param {string} text
 * @param {number} [maxChunkSize=4000]
 * @returns {string[]}
 */
export function splitMessageIntoChunks(text, maxChunkSize = MAX_WHATSAPP_MESSAGE_LENGTH) {
  if (!text || text.length <= maxChunkSize) {
    return [text || ''];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Attempt to split at clean natural boundaries
    let splitIndex = -1;

    // 1. Double line break (paragraphs)
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxChunkSize);
    if (paragraphBreak > maxChunkSize * 0.4) {
      splitIndex = paragraphBreak + 2;
    } else {
      // 2. Single line break
      const singleBreak = remaining.lastIndexOf('\n', maxChunkSize);
      if (singleBreak > maxChunkSize * 0.4) {
        splitIndex = singleBreak + 1;
      } else {
        // 3. Sentence end (.!?)
        const sentenceEnd = remaining.slice(0, maxChunkSize).search(/[.!?]\s+(?=[^.!?]*$)/);
        if (sentenceEnd > maxChunkSize * 0.4) {
          splitIndex = sentenceEnd + 2;
        } else {
          // 4. Word boundary (space)
          const spaceBreak = remaining.lastIndexOf(' ', maxChunkSize);
          if (spaceBreak > 0) {
            splitIndex = spaceBreak + 1;
          } else {
            // 5. Hard slice if no break found
            splitIndex = maxChunkSize;
          }
        }
      }
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Helper to pause execution for a given duration.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a text message to a WhatsApp user via the official WhatsApp Cloud API.
 * Handles automatic chunking if the response exceeds the character limit.
 *
 * @param {string} to - Recipient phone number (E.164 digits)
 * @param {string} messageText - The message content to send
 * @returns {Promise<{ success: boolean, messageIds: string[], chunksSent: number }>}
 */
export async function sendWhatsAppMessage(to, messageText) {
  const normalizedTo = normalizePhoneNumber(to);
  const chunks = splitMessageIntoChunks(messageText);
  const messageIds = [];

  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    privacyLog('warn', 'WHATSAPP_NOT_CONFIGURED', {
      note: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing. Message sending skipped.',
      chunkCount: chunks.length,
    });
    return { success: false, messageIds: [], chunksSent: 0 };
  }

  // Bypass outbound network calls in test scenarios with dummy phone numbers or during test runs
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageIds: [`sim_test_${Date.now()}`], chunksSent: chunks.length };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // If multi-part message, optionally prepend part indicator (e.g. "[1/3]")
    const textToSend = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n\n${chunk}` : chunk;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'text',
      text: {
        preview_url: false,
        body: textToSend,
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json();

      if (!response.ok) {
        privacyLog('error', 'WHATSAPP_SEND_FAILED', {
          status: response.status,
          errorType: responseData?.error?.type,
          errorCode: responseData?.error?.code,
          subcode: responseData?.error?.error_subcode,
        });
        return { success: false, messageIds, chunksSent: i };
      }

      const msgId = responseData?.messages?.[0]?.id || `sim_${Date.now()}`;
      messageIds.push(msgId);

      privacyLog('info', 'WHATSAPP_CHUNK_SENT', {
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        chunkLength: textToSend.length,
      });

      // Pause briefly between chunks to guarantee in-order delivery on WhatsApp
      if (i < chunks.length - 1) {
        await delay(300);
      }
    } catch (err) {
      privacyLog('error', 'WHATSAPP_FETCH_NETWORK_ERROR', {
        message: err.message,
      });
      return { success: false, messageIds, chunksSent: i };
    }
  }

  return { success: true, messageIds, chunksSent: chunks.length };
}

/**
 * Marks an incoming WhatsApp message as read (displays the blue ticks)
 * and displays the native animated typing indicator in WhatsApp.
 *
 * @param {string} messageId - Incoming message WAMID
 * @param {{ typing?: boolean }} [options] - Whether to show the typing indicator (defaults to true)
 * @returns {Promise<boolean>}
 */
export async function markMessageAsRead(messageId, options = {}) {
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !messageId) {
    return false;
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };

  if (options.typing !== false) {
    payload.typing_indicator = { type: 'text' };
  }

  try {
    let response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Fallback without typing_indicator if Meta API version rejects the typing indicator field
    if (!response.ok && payload.typing_indicator) {
      delete payload.typing_indicator;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    }

    return response.ok;
  } catch {
    // Non-critical, ignore read receipt errors
    return false;
  }
}

/**
 * Sends or refreshes the native WhatsApp animated typing indicator for an incoming message.
 *
 * @param {string} messageId - Incoming message WAMID
 * @returns {Promise<boolean>}
 */
export async function sendWhatsAppTypingIndicator(messageId) {
  return markMessageAsRead(messageId, { typing: true });
}

/**
 * Sends an interactive button message (up to 3 buttons) via WhatsApp Cloud API.
 *
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message text
 * @param {Array<{ id: string, title: string }>} buttons - Max 3 buttons
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppButtons(to, bodyText, buttons = []) {
  const normalizedTo = normalizePhoneNumber(to);
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !bodyText) {
    return { success: false, error: 'Missing configuration or body text' };
  }

  // Bypass in test mode
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_btn_${Date.now()}` };
  }

  const cleanButtons = (buttons || []).slice(0, 3).map((b) => ({
    type: 'reply',
    reply: {
      id: String(b.id),
      title: String(b.title).substring(0, 20),
    },
  }));

  // Meta Cloud API interactive buttons enforce a strict 1024-character cap on body text.
  // If the message exceeds 1024 characters, send the full text via standard message chunks first,
  // then dispatch the interactive buttons with a concise action prompt.
  if (bodyText.length > 1024) {
    await sendWhatsAppMessage(normalizedTo, bodyText);
    if (cleanButtons.length === 0) {
      return { success: true };
    }
    return sendWhatsAppButtons(normalizedTo, '⚡ *Quick Actions:*', cleanButtons);
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: cleanButtons,
      },
    },
  };

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_BUTTONS_SEND_FAILED', { status: res.status, error: data?.error?.message });
      return { success: false, error: data?.error?.message };
    }

    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_BUTTONS_NETWORK_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Sends an interactive list menu (up to 10 rows) via WhatsApp Cloud API.
 *
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message text
 * @param {Array<{ id: string, title: string, description?: string }>} rows - Max 10 items
 * @param {string} [buttonText='Options'] - Title of list dropdown button
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppList(to, bodyText, rows = [], buttonText = 'Options') {
  const normalizedTo = normalizePhoneNumber(to);
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !bodyText) {
    return { success: false, error: 'Missing configuration or body text' };
  }

  // Bypass in test mode
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_list_${Date.now()}` };
  }

  const cleanRows = (rows || []).slice(0, 10).map((r) => ({
    id: String(r.id),
    title: String(r.title).substring(0, 24),
    description: r.description ? String(r.description).substring(0, 72) : undefined,
  }));

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: String(buttonText).substring(0, 20),
        sections: [
          {
            title: 'Available Options',
            rows: cleanRows,
          },
        ],
      },
    },
  };

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_LIST_SEND_FAILED', { status: res.status, error: data?.error?.message });
      return { success: false, error: data?.error?.message };
    }

    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_LIST_NETWORK_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Retrieves the download URL for a media asset by its WhatsApp Media ID.
 *
 * @param {string} mediaId - WhatsApp Media ID
 * @returns {Promise<{ url: string, mimeType: string } | null>}
 */
export async function getMediaUrl(mediaId) {
  if (!config.WHATSAPP_TOKEN || !mediaId) {
    return null;
  }

  // Handle mock/test media identifiers gracefully without external network calls
  if (mediaId.startsWith('test_')) {
    return {
      url: 'https://example.com/mock-test-image.jpg',
      mimeType: 'image/jpeg',
    };
  }

  const phoneEndpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${mediaId}?phone_number_id=${config.WHATSAPP_PHONE_NUMBER_ID}`;
  const baseEndpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${mediaId}`;

  for (const endpoint of [phoneEndpoint, baseEndpoint]) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
          'User-Agent': 'WhatsAppBot/1.0 (Node.js)',
        },
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      if (data && data.url) {
        return {
          url: data.url,
          mimeType: data.mime_type || 'image/jpeg',
        };
      }
    } catch {
      // Continue to next endpoint fallback
    }
  }

  privacyLog('warn', 'WHATSAPP_MEDIA_URL_FAILED', { mediaId });
  return null;
}

/**
 * Downloads media binary content directly into an in-memory Buffer.
 * Applies strict timeout and size cap to prevent resource exhaustion.
 * Never persists media to disk (strict volatile RAM architecture).
 *
 * @param {string} mediaUrl - The media URL returned from Meta Graph API
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, base64?: string, reason?: 'too_large' | 'timeout' | 'http_error' } | null>}
 */
export async function downloadMediaInMemory(mediaUrl) {
  if (!config.WHATSAPP_TOKEN || !mediaUrl) {
    return null;
  }

  // Handle mock/test URLs gracefully in tests
  if (mediaUrl.includes('mock-test-image.jpg')) {
    const mockBuffer = Buffer.from('test-image-data');
    return {
      ok: true,
      buffer: mockBuffer,
      base64: mockBuffer.toString('base64'),
    };
  }

  try {
    const signal = AbortSignal.timeout(config.MEDIA_FETCH_TIMEOUT_MS);
    const response = await fetch(mediaUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'User-Agent': 'WhatsAppBot/1.0 (Node.js)',
      },
      signal,
    });

    if (!response.ok) {
      privacyLog('warn', 'WHATSAPP_MEDIA_DOWNLOAD_FAILED', {
        status: response.status,
      });
      return { ok: false, reason: 'http_error' };
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (contentLength > config.MEDIA_MAX_BYTES) {
        privacyLog('warn', 'WHATSAPP_MEDIA_TOO_LARGE', {
          contentLength,
          max: config.MEDIA_MAX_BYTES,
        });
        return { ok: false, reason: 'too_large' };
      }
    }

    // Stream-read chunks to enforce cap even when Content-Length header is omitted
    const chunks = [];
    let receivedBytes = 0;

    if (response.body) {
      for await (const chunk of response.body) {
        receivedBytes += chunk.length;
        if (receivedBytes > config.MEDIA_MAX_BYTES) {
          privacyLog('warn', 'WHATSAPP_MEDIA_STREAM_CAP_EXCEEDED', {
            receivedBytes,
            max: config.MEDIA_MAX_BYTES,
          });
          return { ok: false, reason: 'too_large' };
        }
        chunks.push(Buffer.from(chunk));
      }
    }

    const buffer = Buffer.concat(chunks);
    return {
      ok: true,
      buffer,
      base64: buffer.toString('base64'),
    };
  } catch (err) {
    const isTimeout =
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      (err.message && err.message.toLowerCase().includes('timeout'));

    const reason = isTimeout ? 'timeout' : 'http_error';
    privacyLog('error', 'WHATSAPP_MEDIA_DOWNLOAD_ERROR', {
      reason,
      message: err.message,
    });

    return { ok: false, reason };
  }
}

/**
 * Uploads media directly to Meta's WhatsApp Cloud API media store from an in-memory Buffer.
 * Never writes media to disk (strict volatile RAM architecture).
 *
 * @param {Buffer} buffer - Binary media buffer
 * @param {string} [mimeType='image/jpeg'] - MIME type
 * @returns {Promise<{ success: boolean, mediaId?: string, error?: string }>}
 */
export async function uploadWhatsAppMedia(buffer, mimeType = 'image/jpeg') {
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !buffer) {
    return { success: false, error: 'Missing configuration or buffer' };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/media`;

  const isAudio = mimeType.includes('audio') || mimeType.includes('mpeg') || mimeType.includes('ogg');
  const isVideo = mimeType.includes('video') || mimeType.includes('mp4');
  const filename = isAudio ? 'audio.mp3' : isVideo ? 'video.mp4' : 'image.jpg';
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('type', mimeType);
  formData.append('file', new Blob([buffer], { type: mimeType }), filename);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
      },
      body: formData,
    });

    const data = await res.json();
    if (!res.ok || !data?.id) {
      privacyLog('warn', 'WHATSAPP_MEDIA_UPLOAD_FAILED', {
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message || 'Media upload failed' };
    }

    privacyLog('info', 'WHATSAPP_MEDIA_UPLOAD_SUCCESS', { mediaId: data.id });
    return { success: true, mediaId: data.id };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_MEDIA_UPLOAD_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Sends a read receipt status update to WhatsApp Cloud API.
 * Turns user's message ticks blue immediately for instant visual confirmation.
 */
export const sendWhatsAppReadReceipt = markMessageAsRead;

/**
 * Sends an image message to a WhatsApp user via the WhatsApp Cloud API.
 * Supports clean in-memory Buffers (uploaded directly to Meta) or public HTTPS URLs.
 *
 * @param {string} to - Recipient phone number (E.164 digits)
 * @param {string | Buffer | { buffer: Buffer, mimeType?: string, fallbackUrl?: string }} imageSource
 * @param {string} [caption=''] - Optional caption text
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppImage(to, imageSource, caption = '') {
  const normalizedTo = normalizePhoneNumber(to);
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !imageSource) {
    privacyLog('warn', 'WHATSAPP_IMAGE_SEND_SKIPPED', {
      note: 'Missing token, phone ID, or image source',
    });
    return { success: false, error: 'Missing configuration or image source' };
  }

  // Bypass outbound network calls in test scenarios with dummy phone numbers or during test runs
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_test_img_${Date.now()}` };
  }

  let imagePayload;
  if (Buffer.isBuffer(imageSource) || (imageSource && imageSource.buffer)) {
    const buf = Buffer.isBuffer(imageSource) ? imageSource : imageSource.buffer;
    const mime = imageSource.mimeType || 'image/jpeg';
    const uploadRes = await uploadWhatsAppMedia(buf, mime);
    if (!uploadRes.success) {
      if (imageSource.fallbackUrl) {
        imagePayload = { link: imageSource.fallbackUrl, caption: caption || undefined };
      } else {
        return { success: false, error: uploadRes.error };
      }
    } else {
      imagePayload = { id: uploadRes.mediaId, caption: caption || undefined };
    }
  } else if (typeof imageSource === 'string') {
    imagePayload = { link: imageSource, caption: caption || undefined };
  } else {
    return { success: false, error: 'Invalid image source' };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'image',
    image: imagePayload,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_IMAGE_SEND_FAILED', {
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message };
    }

    const messageId = data?.messages?.[0]?.id;
    privacyLog('info', 'WHATSAPP_IMAGE_SENT', {
      toEnding: normalizedTo.slice(-4),
      messageId,
    });

    return { success: true, messageId };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_IMAGE_SEND_NETWORK_ERROR', {
      message: err.message,
    });
    return { success: false, error: err.message };
  }
}

/**
 * Sends a video message to a WhatsApp user via the WhatsApp Cloud API.
 * Supports clean in-memory Buffers (uploaded directly to Meta) or public HTTPS URLs.
 * Strictly checks the 16MB file size cap for WhatsApp video messages prior to upload.
 *
 * @param {string} to - Recipient phone number (E.164 digits)
 * @param {string | Buffer | { buffer: Buffer, mimeType?: string, fallbackUrl?: string }} videoSource
 * @param {string} [caption=''] - Optional caption text
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppVideo(to, videoSource, caption = '') {
  const normalizedTo = normalizePhoneNumber(to);
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !videoSource) {
    privacyLog('warn', 'WHATSAPP_VIDEO_SEND_SKIPPED', {
      note: 'Missing token, phone ID, or video source',
    });
    return { success: false, error: 'Missing configuration or video source' };
  }

  // Meta WhatsApp Cloud API limits video payloads to 16MB
  if (Buffer.isBuffer(videoSource) || (videoSource && videoSource.buffer)) {
    const buf = Buffer.isBuffer(videoSource) ? videoSource : videoSource.buffer;
    if (buf.length > 16 * 1024 * 1024) {
      return { success: false, error: 'Video exceeds WhatsApp 16MB limit' };
    }
  }

  // Bypass outbound network calls in test scenarios with dummy phone numbers or during test runs
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_test_vid_${Date.now()}` };
  }

  let videoPayload;
  if (Buffer.isBuffer(videoSource) || (videoSource && videoSource.buffer)) {
    const buf = Buffer.isBuffer(videoSource) ? videoSource : videoSource.buffer;
    const mime = videoSource.mimeType || 'video/mp4';
    const uploadRes = await uploadWhatsAppMedia(buf, mime);
    if (!uploadRes.success) {
      if (videoSource.fallbackUrl) {
        videoPayload = { link: videoSource.fallbackUrl, caption: caption || undefined };
      } else {
        return { success: false, error: uploadRes.error };
      }
    } else {
      videoPayload = { id: uploadRes.mediaId, caption: caption || undefined };
    }
  } else if (typeof videoSource === 'string') {
    videoPayload = { link: videoSource, caption: caption || undefined };
  } else {
    return { success: false, error: 'Invalid video source' };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'video',
    video: videoPayload,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_VIDEO_SEND_FAILED', {
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message || 'Failed to send WhatsApp video' };
    }

    const messageId = data?.messages?.[0]?.id || `vid_${Date.now()}`;
    privacyLog('info', 'WHATSAPP_VIDEO_SENT', {
      toEnding: normalizedTo.slice(-4),
      messageId,
    });
    return { success: true, messageId };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_VIDEO_NETWORK_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Sends an audio voice message to a WhatsApp user via the WhatsApp Cloud API.
 * Supports in-memory Buffers (uploaded directly to Meta) or public HTTPS URLs.
 *
 * @param {string} to - Recipient phone number (E.164 digits)
 * @param {string | Buffer | { buffer: Buffer, mimeType?: string, fallbackUrl?: string }} audioSource
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppAudio(to, audioSource) {
  const normalizedTo = normalizePhoneNumber(to);
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !audioSource) {
    privacyLog('warn', 'WHATSAPP_AUDIO_SEND_SKIPPED', {
      note: 'Missing token, phone ID, or audio source',
    });
    return { success: false, error: 'Missing configuration or audio source' };
  }

  // Bypass outbound network calls in test scenarios with dummy phone numbers or during test runs
  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_test_audio_${Date.now()}` };
  }

  let audioPayload;
  if (Buffer.isBuffer(audioSource) || (audioSource && audioSource.buffer)) {
    const buf = Buffer.isBuffer(audioSource) ? audioSource : audioSource.buffer;
    const mime = audioSource.mimeType || 'audio/mpeg';
    const uploadRes = await uploadWhatsAppMedia(buf, mime);
    if (!uploadRes.success) {
      if (audioSource.fallbackUrl) {
        audioPayload = { link: audioSource.fallbackUrl };
      } else {
        return { success: false, error: uploadRes.error };
      }
    } else {
      audioPayload = { id: uploadRes.mediaId };
    }
  } else if (typeof audioSource === 'string') {
    audioPayload = { link: audioSource };
  } else {
    return { success: false, error: 'Invalid audio source' };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'audio',
    audio: audioPayload,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_AUDIO_SEND_FAILED', {
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message };
    }

    const messageId = data?.messages?.[0]?.id;
    privacyLog('info', 'WHATSAPP_AUDIO_SENT', {
      toEnding: normalizedTo.slice(-4),
      messageId,
    });

    return { success: true, messageId };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_AUDIO_SEND_NETWORK_ERROR', {
      message: err.message,
    });
    return { success: false, error: err.message };
  }
}

/**
 * Sends a document file (e.g. PDF, JSON export) via WhatsApp Cloud API.
 *
 * @param {string} to
 * @param {Buffer|string} documentSource - Buffer or URL string
 * @param {string} filename - Display filename
 * @param {string} [caption='']
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppDocument(to, documentSource, filename = 'document.json', caption = '') {
  const normalizedTo = normalizePhoneNumber(to);

  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    privacyLog('warn', 'WHATSAPP_DOCUMENT_SEND_SKIPPED', {
      note: 'Missing token, phone ID, or document source',
    });
    return { success: false, error: 'Missing configuration' };
  }

  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_test_doc_${Date.now()}` };
  }

  let docPayload;
  if (Buffer.isBuffer(documentSource)) {
    const uploadRes = await uploadWhatsAppMedia(documentSource, 'application/json');
    if (!uploadRes.success) {
      return { success: false, error: uploadRes.error };
    }
    docPayload = { id: uploadRes.mediaId, filename, caption };
  } else if (typeof documentSource === 'string') {
    docPayload = { link: documentSource, filename, caption };
  } else {
    return { success: false, error: 'Invalid document source' };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'document',
    document: docPayload,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_DOCUMENT_SEND_FAILED', {
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message };
    }

    const messageId = data?.messages?.[0]?.id;
    return { success: true, messageId };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_DOCUMENT_SEND_NETWORK_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Sends a pre-approved Meta message template (for proactive messaging outside 24h window).
 *
 * @param {string} to
 * @param {string} templateName
 * @param {string} [languageCode='en']
 * @param {Array<object>} [components=[]]
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppTemplate(to, templateName, languageCode = 'en', components = []) {
  const normalizedTo = normalizePhoneNumber(to);

  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !templateName) {
    return { success: false, error: 'Missing token, phone ID, or template name' };
  }

  if (
    config.NODE_ENV === 'test' ||
    normalizedTo === '910000000000' ||
    normalizedTo.startsWith('0000') ||
    normalizedTo.startsWith('9999')
  ) {
    return { success: true, messageId: `sim_test_tpl_${Date.now()}` };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components.length > 0 ? components : undefined,
    },
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      privacyLog('error', 'WHATSAPP_TEMPLATE_SEND_FAILED', {
        status: res.status,
        error: data?.error?.message,
      });
      return { success: false, error: data?.error?.message };
    }

    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_TEMPLATE_NETWORK_ERROR', { error: err.message });
    return { success: false, error: err.message };
  }
}

export { sendWhatsAppInteractive, buildQuickReplyButtons, buildListMenu, buildFlowMessage } from './interactive.js';
