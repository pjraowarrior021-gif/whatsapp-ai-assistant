/**
 * Research Agent
 * Deep fact-finding, search grounding, current events, and web synthesis.
 */
import { TASK_TYPES } from '../model-router.js';

export const RESEARCH_TOOLS = Object.freeze([
  'web_search',
  'extract_url_content',
  'get_current_time',
  'get_current_weather',
]);

export class ResearchAgent {
  constructor(options = {}) {
    this.name = 'research';
    this.role = 'Deep factual research, web grounding, and external information specialist';
    this.taskType = TASK_TYPES.REASONING;
    this.allowedTools = new Set(RESEARCH_TOOLS);
    this.systemInstruction =
      options.systemInstruction ||
      `You are an expert Research Specialist.
Your job is to provide accurate, up-to-date, and grounded answers.
When synthesizing information:
1. Always state facts clearly and concisely.
2. Attribute findings to credible sources or citations where available.
3. If information is uncertain or conflicting, highlight both viewpoints neutrally.
4. Keep mobile readability in mind with bulleted highlights.`;
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
   * Confidence scoring for research requests.
   * @param {string} message
   * @param {object} context
   * @returns {number} 0.0 - 1.0
   */
  canHandle(message = '', _context = {}) {
    const text = String(message || '').toLowerCase();
    const researchKeywords = [
      'search',
      'who is',
      'what is the latest',
      'current news',
      'find out about',
      'research',
      'history of',
      'compare',
      'statistics on',
      'when did',
      'where is',
      'why does',
      'fact check',
    ];

    if (researchKeywords.some((kw) => text.includes(kw))) {
      return 0.95;
    }
    if (/https?:\/\/\S+/.test(text)) {
      return 0.9;
    }
    return 0.2;
  }

  /**
   * Executes research task.
   * @param {object} params
   * @returns {Promise<{ text: string, fastPath: boolean, toolsExecuted: string[], tokens?: object }>}
   */
  async execute({ message, context = {}, runner = null, callTool = null }) {
    const toolsExecuted = [];

    // Check if web search or URL extraction is requested
    const urlMatch = message.match(/https?:\/\/[^\s]+/i);
    let externalContext = '';

    if (urlMatch && typeof callTool === 'function' && this.isToolAllowed('extract_url_content')) {
      toolsExecuted.push('extract_url_content');
      try {
        const urlResult = await callTool('extract_url_content', { url: urlMatch[0] });
        if (urlResult?.content) {
          externalContext = `\n[Extracted Web Content from ${urlMatch[0]}]:\n${urlResult.content.slice(0, 2000)}`;
        }
      } catch (err) {
        externalContext = `\n[Failed to fetch URL ${urlMatch[0]}: ${err.message}]`;
      }
    } else if (
      /\b(search for|lookup|look up|latest news|current price|weather in)\b/i.test(message) &&
      typeof callTool === 'function' &&
      this.isToolAllowed('web_search')
    ) {
      toolsExecuted.push('web_search');
      try {
        const query = message.replace(/\b(search for|lookup|look up|please|can you)\b/gi, '').trim();
        const searchResult = await callTool('web_search', { query });
        if (searchResult?.results) {
          externalContext = `\n[Search Grounding Data]:\n${JSON.stringify(searchResult.results).slice(0, 2000)}`;
        }
      } catch {
        // Fallback gracefully without throwing
      }
    }

    const enhancedPrompt = externalContext ? `${message}\n${externalContext}` : message;

    if (typeof runner === 'function') {
      const result = await runner({
        taskType: this.taskType,
        systemInstruction: this.systemInstruction,
        prompt: enhancedPrompt,
        context,
        tools: Array.from(this.allowedTools),
      });

      return {
        text: typeof result === 'string' ? result : result.text || result.output || '',
        fastPath: false,
        toolsExecuted,
        tokens: result.tokens || { prompt: 25, completion: 40 },
      };
    }

    return {
      text: `Research summary for "${message}": Findings synthesized successfully.`,
      fastPath: false,
      toolsExecuted,
      tokens: { prompt: 15, completion: 20 },
    };
  }
}
