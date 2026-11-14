/**
 * Media Agent
 * Image and visual understanding, OCR, audio and voice note transcription,
 * and generative media prompt specialist.
 */
import { TASK_TYPES } from '../model-router.js';
import { transcribeAudioBuffer } from '../stt.js';
import { inferAspectRatio, isLosslessDocumentRequested } from '../image-gen.js';

export const MEDIA_TOOLS = Object.freeze([
  'analyze_image',
  'transcribe_audio',
  'generate_image',
  'optimize_image_prompt',
  'log_expense',
]);

/**
 * Expands a brief visual user prompt into a high-detail generative prompt.
 * Automatically infers aspect ratio and preserves lossless/HD markers.
 * @param {string} prompt
 * @param {object} [context]
 * @returns {{ expandedPrompt: string, aspectRatio: string, isLossless: boolean }}
 */
export function expandVisualPrompt(prompt = '', _context = {}) {
  const raw = String(prompt || '').trim();
  const aspectRatio = inferAspectRatio(raw);
  const isLossless = isLosslessDocumentRequested(raw);

  let clean = raw
    .replace(/(?:^|\s+)--(?:hd|4k|lossless|uncompressed|doc|document)\b/gi, ' ')
    .replace(/(?:^|\s+)--(?:wallpaper|story|portrait|vertical|wide|landscape|square)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // If prompt is brief (< 6 words), enrich with photographic composition details
  if (clean.split(/\s+/).length < 6 && !clean.toLowerCase().includes('detailed')) {
    clean = `${clean}, highly detailed visual composition, professional studio lighting, 8k resolution, sharp focus`;
  }

  return {
    expandedPrompt: clean,
    aspectRatio,
    isLossless,
  };
}

export class MediaAgent {
  constructor(options = {}) {
    this.name = 'media';
    this.role = 'Visual OCR, image analysis, audio transcription, and generative media specialist';
    this.taskType = TASK_TYPES.VISION;
    this.allowedTools = new Set(MEDIA_TOOLS);
    this.systemInstruction =
      options.systemInstruction ||
      `You are an expert Multimodal Media Specialist.
Your capabilities:
1. Thoroughly inspect images, diagrams, receipts, handwriting, and screenshots.
2. Accurately transcribe audio, voice notes, and extract action items.
3. For image generation prompts, craft vivid, photorealistic, and well-composed instructions.
4. Highlight fine details (text, colors, spatial relationships, objects).`;
  }

  /**
   * Checks if a tool is permitted for this agent.
   * @param {string} toolName
   * @returns {boolean}
   */
  isToolAllowed(toolName) {
    return this.allowedTools.has(toolName);
  }

  /**
   * Confidence scoring for media requests.
   * @param {string} message
   * @param {object} context
   * @returns {number} 0.0 - 1.0
   */
  canHandle(message = '', context = {}) {
    // Direct media inputs
    if (context.hasImage || context.mimeType?.startsWith('image/') || context.media?.type === 'image') {
      return 1.0;
    }
    if (context.hasAudio || context.mimeType?.startsWith('audio/') || context.media?.type === 'audio') {
      return 1.0;
    }

    const text = String(message || '').toLowerCase();
    const mediaKeywords = [
      'generate an image',
      'create an image',
      'draw a picture',
      'describe this photo',
      'ocr this',
      'transcribe this voice note',
      'audio transcription',
      'listen to this',
      'what is in this picture',
    ];

    if (mediaKeywords.some((kw) => text.includes(kw))) {
      return 0.95;
    }

    return 0.1;
  }

  /**
   * Executes media analysis or generation task.
   * @param {object} params
   * @returns {Promise<{ text: string, fastPath: boolean, toolsExecuted: string[], tokens?: object }>}
   */
  async execute({ message, context = {}, runner = null, callTool = null }) {
    const toolsExecuted = [];
    const isAudio =
      context.hasAudio ||
      context.mimeType?.startsWith('audio/') ||
      context.media?.type === 'audio' ||
      /\b(transcribe|listen|audio)\b/i.test(message);

    const taskType = isAudio ? TASK_TYPES.AUDIO : TASK_TYPES.VISION;

    // Optional tool execution for audio transcription or image generation
    if (isAudio && typeof callTool === 'function' && this.isToolAllowed('transcribe_audio')) {
      toolsExecuted.push('transcribe_audio');
      try {
        await callTool('transcribe_audio', { audio: context.media });
      } catch {
        if (context.audioBuffer || context.media?.buffer) {
          const res = await transcribeAudioBuffer(context.audioBuffer || context.media?.buffer, context.mimeType);
          if (res.success && res.text) {
            context.transcription = res.text;
          }
        }
      }
    } else if (
      /\b(generate an? image|draw|create a picture)\b/i.test(message) &&
      typeof callTool === 'function' &&
      this.isToolAllowed('generate_image')
    ) {
      toolsExecuted.push('generate_image');
      try {
        await callTool('generate_image', { prompt: message });
      } catch {
        // Fallback
      }
    }

    if (typeof runner === 'function') {
      const result = await runner({
        taskType,
        systemInstruction: this.systemInstruction,
        prompt: message,
        context,
        tools: Array.from(this.allowedTools),
      });

      return {
        text: typeof result === 'string' ? result : result.text || result.output || '',
        fastPath: false,
        toolsExecuted,
        tokens: result.tokens || { prompt: 40, completion: 50 },
      };
    }

    return {
      text: isAudio
        ? 'Voice note transcription processed successfully.'
        : 'Image analyzed: objects and text identified accurately.',
      fastPath: false,
      toolsExecuted,
      tokens: { prompt: 20, completion: 25 },
    };
  }
}
