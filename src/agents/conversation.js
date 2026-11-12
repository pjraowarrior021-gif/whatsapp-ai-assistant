/**
 * Conversation Agent
 * Fast-path conversational specialist for greetings, chit-chat,
 * persona adaptation, and general dialogue with zero agentic overhead (< 1 turn).
 */
import { TASK_TYPES } from '../model-router.js';

export const GREETING_PATTERNS = [
  /^(hi|hello|hey|hiya|howdy|holla|yo|namaste|salaam|bonjour|hola)(\s+.*)?$/i,
  /^(good\s+(morning|afternoon|evening|night|day))(\s+.*)?$/i,
  /^(how\s+are\s+you|how's\s+it\s+going|what's\s+up|sup|how\s+r\s+u)(\s+.*)?$/i,
  /^(thank\s+you|thanks|thx|ty|much\s+appreciated)(\s+.*)?$/i,
  /^(ok|okay|cool|nice|great|awesome|got\s+it|understood|alright|sure|fine)(\s+.*)?$/i,
  /^(bye|goodbye|see\s+ya|catch\s+you\s+later|gn|cya)(\s+.*)?$/i,
  /^(who\s+are\s+you|what\s+can\s+you\s+do|introduce\s+yourself)(\s+.*)?$/i,
];

export class ConversationAgent {
  constructor(options = {}) {
    this.name = 'conversation';
    this.role = 'Friendly, concise personal conversational assistant';
    this.taskType = TASK_TYPES.CHAT;
    this.allowedTools = new Set(); // Pure conversational, no tool overhead
    this.systemInstruction =
      options.systemInstruction ||
      `You are a thoughtful, friendly, and concise assistant on WhatsApp.
Keep responses bite-sized, warm, helpful, and natural without robotic filler.`;
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
   * Fast-path detection: determines if an input is a pure greeting or casual turn.
   * @param {string} text
   * @returns {boolean}
   */
  isGreeting(text = '') {
    const trimmed = String(text || '')
      .trim()
      .replace(/[!.,?]+$/, '')
      .trim();
    if (!trimmed || trimmed.length > 80) return false;
    return GREETING_PATTERNS.some((regex) => regex.test(trimmed));
  }

  /**
   * Generates instant fast-path responses without invoking an LLM.
   * @param {string} text
   * @returns {string|null}
   */
  getFastGreetingResponse(text = '') {
    const lower = String(text || '')
      .trim()
      .replace(/[!.,?]+$/, '')
      .trim()
      .toLowerCase();

    if (/^(hi|hello|hey|yo|namaste|hiya)\b/i.test(lower)) {
      return 'Hey there! How can I help you today?';
    }
    if (/good\s+morning/i.test(lower)) {
      return 'Good morning! Hope you have a productive day ahead. What can I do for you?';
    }
    if (/good\s+(afternoon|evening)/i.test(lower)) {
      return 'Good day! How can I assist you right now?';
    }
    if (/good\s+night/i.test(lower)) {
      return 'Good night! Rest well. Let me know tomorrow if you need anything.';
    }
    if (/how\s+are\s+you|how's\s+it\s+going|what's\s+up|sup/i.test(lower)) {
      return "I'm doing great, thanks for asking! Ready to help you with tasks, code, research, or reminders. What's on your mind?";
    }
    if (/thank|thx|appreciate/i.test(lower)) {
      return "You're very welcome! Always here if you need anything else.";
    }
    if (/^(ok|okay|cool|nice|great|awesome|got\s+it|alright)\b/i.test(lower)) {
      return 'Sounds good! Let me know whenever you need assistance.';
    }
    if (/bye|goodbye|see\s+ya/i.test(lower)) {
      return 'Goodbye! Have a great time ahead.';
    }
    if (/who\s+are\s+you|what\s+can\s+you\s+do/i.test(lower)) {
      return `I am your personal AI assistant! I can help you with:
• Fast Q&A and conversations
• Reminders and to-do lists
• Code debugging and writing
• Document and PDF analysis
• Web research and fact-finding
• Image and audio understanding`;
    }

    return null;
  }

  /**
   * Confidence scoring for request handling.
   * @param {string} message
   * @param {object} context
   * @returns {number} 0.0 - 1.0
   */
  canHandle(message = '', context = {}) {
    if (this.isGreeting(message)) return 1.0;
    if (!context.media && !context.isDocument) return 0.6;
    return 0.3;
  }

  /**
   * Executes conversation handling.
   * Supports immediate fast-path responses or calling the model runner.
   * @param {object} params
   * @returns {Promise<{ text: string, fastPath: boolean, tokens?: object }>}
   */
  async execute({ message, context = {}, runner = null }) {
    // 1. Check instant fast-path
    if (this.isGreeting(message)) {
      const fastReply = this.getFastGreetingResponse(message);
      if (fastReply) {
        return {
          text: fastReply,
          fastPath: true,
          tokens: { prompt: 0, completion: 0 },
        };
      }
    }

    // 2. Call model runner if provided
    if (typeof runner === 'function') {
      const result = await runner({
        taskType: this.taskType,
        systemInstruction: this.systemInstruction,
        prompt: message,
        context,
      });
      return {
        text: typeof result === 'string' ? result : result.text || result.output || '',
        fastPath: false,
        tokens: result.tokens || { prompt: 10, completion: 15 },
      };
    }

    // Fallback standard response
    return {
      text: "I'm here! What would you like to explore or get done?",
      fastPath: true,
      tokens: { prompt: 0, completion: 0 },
    };
  }
}
