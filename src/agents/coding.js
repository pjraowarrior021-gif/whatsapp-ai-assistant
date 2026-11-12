/**
 * Coding Agent
 * Code synthesis, syntax debugging, architecture review, and refactoring specialist.
 */
import { TASK_TYPES } from '../model-router.js';

export const CODING_TOOLS = Object.freeze(['format_code', 'lint_syntax', 'run_sandbox_code']);

export class CodingAgent {
  constructor(options = {}) {
    this.name = 'coding';
    this.role = 'Expert software engineer and debugging specialist';
    this.taskType = TASK_TYPES.CODING;
    this.allowedTools = new Set(CODING_TOOLS);
    this.systemInstruction =
      options.systemInstruction ||
      `You are an expert Software Engineer on WhatsApp.
Your code and explanations follow these strict principles:
1. Ultra-concise, technical, and code-first.
2. Complete, correct, production-grade code snippets enclosed in markdown \`\`\`language blocks.
3. Skip fluffy pleasantries ("Sure! Here is the code").
4. For bug reports or stack traces: state the root cause in 1 sentence, followed immediately by the patch.
5. Emphasize security, error handling, and performance.`;
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
   * Confidence scoring for coding requests.
   * @param {string} message
   * @param {object} context
   * @returns {number} 0.0 - 1.0
   */
  canHandle(message = '', _context = {}) {
    const text = String(message || '').toLowerCase();

    // Check code blocks
    if (/```[\s\S]*```/.test(message)) return 0.95;

    // Check errors and exceptions
    if (/\b(error|exception|traceback|syntaxerror|typeerror|undefined|segfault|nullpointer)\b/i.test(text)) {
      return 0.85;
    }

    // Check programming keywords
    const keywords = [
      'write a function',
      'code for',
      'debug',
      'refactor',
      'regex',
      'sql query',
      'dockerfile',
      'git commit',
      'python script',
      'javascript',
      'typescript',
      'algorithm',
      'unit test',
      'api endpoint',
      'async await',
    ];
    if (keywords.some((kw) => text.includes(kw))) {
      return 0.9;
    }

    return 0.15;
  }

  /**
   * Executes coding task.
   * @param {object} params
   * @returns {Promise<{ text: string, fastPath: boolean, toolsExecuted: string[], tokens?: object }>}
   */
  async execute({ message, context = {}, runner = null, callTool = null }) {
    const toolsExecuted = [];

    // Optional tool execution if format_code or lint_syntax is requested
    if (message.includes('format code') && typeof callTool === 'function' && this.isToolAllowed('format_code')) {
      toolsExecuted.push('format_code');
      try {
        await callTool('format_code', { code: message });
      } catch {
        // Fallback gracefully
      }
    }

    if (typeof runner === 'function') {
      const result = await runner({
        taskType: this.taskType,
        systemInstruction: this.systemInstruction,
        prompt: message,
        context,
        tools: Array.from(this.allowedTools),
      });

      return {
        text: typeof result === 'string' ? result : result.text || result.output || '',
        fastPath: false,
        toolsExecuted,
        tokens: result.tokens || { prompt: 30, completion: 50 },
      };
    }

    return {
      text: `\`\`\`js\n// Solution for: ${message.slice(0, 50)}\nfunction solve() {\n  return true;\n}\n\`\`\``,
      fastPath: false,
      toolsExecuted,
      tokens: { prompt: 20, completion: 30 },
    };
  }
}
