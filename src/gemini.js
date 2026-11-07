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
4. If a user asks about privacy, data boundaries, or commands, remind them they can type /privacy or /help.`;

/**
 * Generates an AI response using the Google Gemini API with conversational context.
 *
 * @param {string} userMessage - The sanitized user input
 * @param {Array<{role: string, parts: Array<{text: string}>}>} conversationHistory - Prior turns from in-memory session
 * @returns {Promise<string>} The assistant's response text
 */
export async function generateAIResponse(userMessage, conversationHistory = []) {
  const startTime = Date.now();
  const client = getGeminiClient();

  // Construct context payload: prior turns + current user message
  const contents = [
    ...conversationHistory,
    {
      role: 'user',
      parts: [{ text: userMessage }],
    },
  ];

  try {
    const response = await client.models.generateContent({
      model: activeModel,
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
      model: activeModel,
      historyLength: conversationHistory.length,
      inputLength: userMessage.length,
      outputLength: responseText.length,
      latencyMs,
    });

    if (!responseText) {
      return "I'm sorry, I couldn't generate a response for that. Please try rephrasing your message.";
    }

    return responseText;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error?.message || String(error);

    privacyLog('error', 'GEMINI_API_ERROR', {
      model: activeModel,
      errorMessage: errorMessage.replace(/key=[^&\s]+/gi, 'key=REDACTED'),
      latencyMs,
    });

    // Handle rate limits / resource exhaustion
    if (errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
      return '⏳ *Rate Limit Notice:* Gemini API request limit reached. Please wait a minute before sending your next message.';
    }

    // Handle context length or quota errors
    if (errorMessage.includes('quota') || errorMessage.includes('QUOTA_EXCEEDED')) {
      return '⚠️ *Quota Exceeded:* The Gemini API free quota has been temporarily reached. Please try again later or check your API limits at https://aistudio.google.com.';
    }

    return '⚠️ *Error:* Unable to generate an AI response right now. Please try again in a few moments.';
  }
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
