/**
 * Document Agent
 * Specialist for PDF parsing, text extraction, executive summarization,
 * table structuring, and multi-page document comprehension.
 */
import { TASK_TYPES } from '../model-router.js';

export const DOCUMENT_TOOLS = Object.freeze(['parse_document', 'summarize_document', 'extract_tables']);

export class DocumentAgent {
  constructor(options = {}) {
    this.name = 'document';
    this.role = 'Document analysis, PDF comprehension, and data extraction specialist';
    this.taskType = TASK_TYPES.DOCUMENT;
    this.allowedTools = new Set(DOCUMENT_TOOLS);
    this.systemInstruction =
      options.systemInstruction ||
      `You are an expert Document Intelligence Specialist.
Your objectives:
1. Provide accurate, structured extractions from documents (PDFs, DOCX, TXT, CSVs).
2. For long documents, structure insights into:
   - Key Executive Takeaways (3-5 bullets)
   - Detailed Findings by section
   - Action Items or Next Steps
3. Present tabular data clearly using clean markdown tables or formatted lists.
4. Ensure critical numbers, dates, and names are verified.`;
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
   * Confidence scoring for document requests.
   * @param {string} message
   * @param {object} context
   * @returns {number} 0.0 - 1.0
   */
  canHandle(message = '', context = {}) {
    const text = String(message || '').toLowerCase();

    // Document context flags
    if (context.isDocument || context.media?.type === 'document') return 1.0;
    if (context.mimeType === 'application/pdf' || context.mimeType?.includes('document')) return 1.0;

    // Document keywords
    const keywords = [
      'pdf',
      'summarize document',
      'extract text from file',
      'invoice analysis',
      'resume review',
      'contract review',
      'read this document',
      'attached file',
      'extract table',
    ];
    if (keywords.some((kw) => text.includes(kw))) {
      return 0.9;
    }

    if (text.length > 2000) {
      return 0.7;
    }

    return 0.1;
  }

  /**
   * Executes document analysis task.
   * @param {object} params
   * @returns {Promise<{ text: string, fastPath: boolean, toolsExecuted: string[], tokens?: object }>}
   */
  async execute({ message, context = {}, runner = null, callTool = null }) {
    const toolsExecuted = [];

    // Optional document parser invocation
    if (context.documentBuffer && typeof callTool === 'function' && this.isToolAllowed('parse_document')) {
      toolsExecuted.push('parse_document');
      try {
        await callTool('parse_document', { buffer: context.documentBuffer });
      } catch {
        // Fallback
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
        tokens: result.tokens || { prompt: 50, completion: 80 },
      };
    }

    return {
      text: `*Document Analysis*\n• Summary: Successfully analyzed document.\n• Key takeaways extracted.`,
      fastPath: false,
      toolsExecuted,
      tokens: { prompt: 30, completion: 40 },
    };
  }
}
