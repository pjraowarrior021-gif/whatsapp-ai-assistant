import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { privacyLog } from './privacy.js';

let aiClient = null;
let activeModel = config.GEMINI_MODEL;

/**
 * Initializes or returns the Google Gen AI SDK client.
 * @returns {GoogleGenAI}
 */
export function getGeminiClient() {
  if (!aiClient) {
    if (!config.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    aiClient = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }
  return aiClient;
}

/**
 * Allows runtime model switching (e.g. gemini-2.5-flash, gemini-1.5-flash).
 * @param {string} modelName
 */
export function setActiveModel(modelName) {
  if (modelName && typeof modelName === 'string') {
    activeModel = modelName.trim();
    privacyLog('info', 'GEMINI_MODEL_SWITCHED', { model: activeModel });
  }
}

/**
 * Returns current active model name.
 * @returns {string}
 */
export function getActiveModel() {
  return activeModel;
}

const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash'];

/**
 * WhatsApp-optimized System Instructions
 */
const SYSTEM_INSTRUCTION = `You are a high-performing, private Personal AI Assistant on WhatsApp powered by Google Gemini.
Your core operating rules:
1. Provide concise, clear, and helpful answers optimized for quick mobile reading on WhatsApp.
2. Use WhatsApp formatting conventions:
   - *bold* for emphasis or titles
   - _italics_ for secondary notes or clarification
   - ~strikethrough~ where appropriate
   - \`\`\`code blocks\`\`\` for code or formatted data
   - Bulleted lists with emoji or hyphens for clean reading
   - Do NOT use HTML tags (e.g. <b>, <i>, <a>).
3. Be respectful, objective, and privacy-conscious:
   - NEVER request, verify, or store passwords, OTPs, UPI PINs, CVVs, or bank account credentials.
   - If a user mentions financial codes or credentials, remind them never to send sensitive credentials over messaging platforms.
4. If a user asks about privacy, data boundaries, or commands, remind them they can type /privacy or /help.
5. When analyzing images, diagrams, error messages, documents, or photos, inspect all visible details, transcribe relevant code or text, and provide fast, precise, and practical solutions.`;

/**
 * Generates an AI response using the Google Gemini API with conversational context and optional image input.
 *
 * @param {string} userMessage - The sanitized user input or image caption
 * @param {Array<{role: string, parts: Array<{text: string}>}>} conversationHistory - Prior turns from in-memory session
 * @param {{ mimeType: string, data: string } | null} [imagePart=null] - Optional base64-encoded image
 * @returns {Promise<string>} The assistant's response text
 */
export async function generateAIResponse(userMessage, conversationHistory = [], imagePart = null) {
  const startTime = Date.now();
  const client = getGeminiClient();

  const userParts = [];
  if (imagePart && imagePart.data) {
    userParts.push({
      inlineData: {
        mimeType: imagePart.mimeType || 'image/jpeg',
        data: imagePart.data,
      },
    });
  }

  const promptText =
    userMessage && userMessage.trim().length > 0
      ? userMessage.trim()
      : 'Analyze this image in detail. Identify any text, diagrams, code, questions, or problems, and provide a clear, comprehensive solution or explanation.';

  userParts.push({ text: promptText });

  // Construct context payload: prior turns + current user message/image
  const contents = [
    ...conversationHistory,
    {
      role: 'user',
      parts: userParts,
    },
  ];

  // Try active model first, then gracefully cascade through fallbacks if quota/overload occurs
  const candidateModels = [
    activeModel,
    ...FALLBACK_MODELS.filter((m) => m !== activeModel),
  ];

  let lastError = null;

  for (const modelToTry of candidateModels) {
    try {
      const response = await client.models.generateContent({
        model: modelToTry,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: config.GEMINI_TEMPERATURE,
          maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const latencyMs = Date.now() - startTime;
      const responseText = response.text ? response.text.trim() : '';

      privacyLog('info', 'GEMINI_RESPONSE_GENERATED', {
        model: modelToTry,
        historyLength: conversationHistory.length,
        inputLength: userMessage.length,
        outputLength: responseText.length,
        latencyMs,
      });

      if (responseText) {
        return responseText;
      }
    } catch (error) {
      lastError = error;
      const errorMessage = error?.message || String(error);

      privacyLog('warn', 'GEMINI_MODEL_ATTEMPT_FAILED', {
        model: modelToTry,
        errorMessage: errorMessage.substring(0, 150).replace(/key=[^&\s]+/gi, 'key=REDACTED'),
      });
    }
  }

  const latencyMs = Date.now() - startTime;
  const errorMsg = lastError?.message || String(lastError || 'Unknown error');

  privacyLog('error', 'GEMINI_ALL_MODELS_FAILED', {
    attemptedModels: candidateModels,
    latencyMs,
  });

  if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
    return '⏳ *Rate Limit Notice:* Gemini API request limit reached. Please wait a minute before sending your next message.';
  }

  if (errorMsg.includes('quota') || errorMsg.includes('QUOTA_EXCEEDED')) {
    return '⚠️ *Quota Exceeded:* The Gemini API free quota has been temporarily reached. Please try again later or check your API limits at https://aistudio.google.com.';
  }

  return '⚠️ *Error:* Unable to generate an AI response right now. Please try again in a few moments.';
}

/**
 * Runs a lightweight test connection against the Gemini API to verify API key validity.
 * @returns {Promise<{ success: boolean, model: string, latencyMs: number, error?: string }>}
 */
export async function testGeminiConnection() {
  const start = Date.now();
  try {
    const client = getGeminiClient();
    const response = await client.models.generateContent({
      model: activeModel,
      contents: 'Ping: Reply with single word PONG',
    });

    const latencyMs = Date.now() - start;
    const reply = response.text ? response.text.trim() : '';
    const success = Boolean(reply && reply.length > 0);

    return {
      success,
      model: activeModel,
      latencyMs,
      reply,
    };
  } catch (err) {
    return {
      success: false,
      model: activeModel,
      latencyMs: Date.now() - start,
      error: (err.message || String(err)).replace(/key=[^&\s]+/gi, 'key=REDACTED'),
    };
  }
}
