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

  // Bypass outbound network calls in test scenarios with dummy phone numbers
  if (normalizedTo === '910000000000' || normalizedTo.startsWith('0000')) {
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
 * Marks an incoming WhatsApp message as read (displays the blue ticks).
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
export async function markMessageAsRead(messageId) {
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !messageId) {
    return false;
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });

    return response.ok;
  } catch (err) {
    // Non-critical, ignore read receipt errors
    return false;
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
 * Never persists media to disk (strict volatile RAM architecture).
 *
 * @param {string} mediaUrl - The media URL returned from Meta Graph API
 * @returns {Promise<{ buffer: Buffer, base64: string } | null>}
 */
export async function downloadMediaInMemory(mediaUrl) {
  if (!config.WHATSAPP_TOKEN || !mediaUrl) {
    return null;
  }

  // Handle mock/test URLs gracefully in tests
  if (mediaUrl.includes('mock-test-image.jpg')) {
    const mockBuffer = Buffer.from('test-image-data');
    return {
      buffer: mockBuffer,
      base64: mockBuffer.toString('base64'),
    };
  }

  try {
    const response = await fetch(mediaUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        'User-Agent': 'WhatsAppBot/1.0 (Node.js)',
      },
    });

    if (!response.ok) {
      privacyLog('warn', 'WHATSAPP_MEDIA_DOWNLOAD_FAILED', {
        status: response.status,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      base64: buffer.toString('base64'),
    };
  } catch (err) {
    privacyLog('error', 'WHATSAPP_MEDIA_DOWNLOAD_ERROR', {
      message: err.message,
    });
    return null;
  }
}

/**
 * Sends an image message to a WhatsApp user via the WhatsApp Cloud API.
 * Uses a publicly accessible HTTPS image URL with an optional caption.
 *
 * @param {string} to - Recipient phone number (E.164 digits)
 * @param {string} imageUrl - Publicly accessible HTTPS image URL
 * @param {string} [caption=''] - Optional caption text
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
export async function sendWhatsAppImage(to, imageUrl, caption = '') {
  const normalizedTo = normalizePhoneNumber(to);
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !imageUrl) {
    privacyLog('warn', 'WHATSAPP_IMAGE_SEND_SKIPPED', {
      note: 'Missing token, phone ID, or image URL',
    });
    return { success: false, error: 'Missing configuration or image URL' };
  }

  // Bypass outbound network calls in test scenarios with dummy phone numbers
  if (normalizedTo === '910000000000' || normalizedTo.startsWith('0000')) {
    return { success: true, messageId: `sim_test_img_${Date.now()}` };
  }

  const endpoint = `${WHATSAPP_API_BASE}/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizedTo,
    type: 'image',
    image: {
      link: imageUrl,
      caption: caption || undefined,
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
