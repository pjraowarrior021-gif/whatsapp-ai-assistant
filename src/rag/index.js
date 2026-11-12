/**
 * Personal RAG Engine
 *
 * Coordinates document ingestion (PDF, DOCX, PPTX, XLSX, TXT, MD, notes),
 * duplicate detection via SHA-256 content hashing, smart chunking,
 * pluggable embeddings, and hybrid retrieval with reciprocal rank fusion.
 *
 * Security: Strictly multi-tenant partitioned by anonId with zero cross-user leakage.
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { chunkText, chunkPages } from './chunker.js';
import { createEmbeddingProvider } from './embeddings.js';
import { RagStore } from './store.js';
import { extractDocumentContent } from '../document.js';
import { privacyLog } from '../privacy.js';

export { chunkText, chunkPages };

/**
 * Extracts plain text from a raw PDF buffer in-memory without external binary dependencies.
 *
 * @param {Buffer} buffer - PDF binary buffer
 * @returns {{ ok: boolean, text?: string, error?: string }}
 */
export function extractTextFromPdfBuffer(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { ok: false, error: 'Empty or invalid PDF buffer' };
    }

    const pdfString = buffer.toString('binary');
    if (!pdfString.startsWith('%PDF-')) {
      // If it doesn't have PDF magic bytes, try utf-8 text fallback
      const rawText = buffer.toString('utf8').trim();
      if (rawText.length > 0) {
        return { ok: true, text: rawText };
      }
      return { ok: false, error: 'Not a valid PDF document' };
    }

    // Locate stream ... endstream blocks
    const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
    const extractedParagraphs = [];
    let match;

    while ((match = streamRegex.exec(pdfString)) !== null) {
      const streamBinary = match[1];
      const streamBuf = Buffer.from(streamBinary, 'binary');

      let uncompressed = null;
      // Try zlib inflate (standard PDF FlateDecode)
      try {
        uncompressed = zlib.inflateSync(streamBuf);
      } catch {
        try {
          uncompressed = zlib.inflateRawSync(streamBuf);
        } catch {
          // If not compressed, test if raw stream is readable ASCII/UTF-8
          uncompressed = streamBuf;
        }
      }

      if (!uncompressed) continue;

      const contentStr = uncompressed.toString('latin1');
      // Extract text from standard PDF operators: (text) Tj, [(t1) (t2)] TJ
      const textMatches = [];

      // Operator 1: (Text) Tj or '
      const tjRegex = /\((.*?)\)\s*(?:Tj|'|")/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(contentStr)) !== null) {
        const decoded = decodePdfString(tjMatch[1]);
        if (decoded.trim()) textMatches.push(decoded.trim());
      }

      // Operator 2: [(T) 100 (ext)] TJ
      const tjArrayRegex = /\[(.*?)\]\s*TJ/g;
      let arrayMatch;
      while ((arrayMatch = tjArrayRegex.exec(contentStr)) !== null) {
        const inner = arrayMatch[1];
        const innerStrings = inner.match(/\((.*?)\)/g);
        if (innerStrings) {
          const combined = innerStrings
            .map((s) => decodePdfString(s.slice(1, -1)))
            .join('')
            .trim();
          if (combined) textMatches.push(combined);
        }
      }

      if (textMatches.length > 0) {
        extractedParagraphs.push(textMatches.join(' '));
      }
    }

    const fullText = extractedParagraphs.join('\n\n').trim();
    if (fullText.length > 0) {
      return { ok: true, text: fullText };
    }

    // Fallback: extract printable strings if stream parsing returned no operators
    const printableMatches = pdfString.match(/[A-Za-z0-9 .,;:!?'"()\-_/\n]{4,}/g);
    if (printableMatches && printableMatches.length > 0) {
      const filtered = printableMatches.filter(
        (s) => !s.startsWith('/Font') && !s.startsWith('/Type') && !s.includes('endobj')
      );
      if (filtered.length > 0) {
        return { ok: true, text: filtered.join(' ') };
      }
    }

    return { ok: true, text: '' };
  } catch (err) {
    privacyLog('warn', 'PDF_TEXT_EXTRACTION_FAILED', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Decodes standard PDF escape sequences.
 *
 * @param {string} str
 * @returns {string}
 */
function decodePdfString(str) {
  if (!str) return '';
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * Computes deterministic SHA-256 hash of a content string or Buffer.
 *
 * @param {string|Buffer} content
 * @returns {string} Hex hash string
 */
export function computeContentHash(content) {
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(content)) {
    hash.update(content);
  } else {
    hash.update(String(content || ''), 'utf8');
  }
  return hash.digest('hex');
}

/**
 * Personal RAG Engine coordinating chunking, embeddings, and hybrid retrieval.
 */
export class RagEngine {
  /**
   * @param {object} [options={}]
   * @param {string} [options.embeddingProvider='local']
   * @param {object} [options.embeddingOptions={}]
   * @param {RagStore} [options.store]
   */
  constructor(options = {}) {
    this.store = options.store || new RagStore();
    this.embeddings = createEmbeddingProvider(options.embeddingProvider || 'local', options.embeddingOptions || {});
    // Map<anonId, Map<docId, DocumentRecord>>
    this.documents = new Map();
    // Map<anonId, Map<hash, docId>> (for instant duplicate detection)
    this.hashIndex = new Map();
  }

  /**
   * Asserts valid anonId and returns tenant maps.
   *
   * @param {string} anonId
   * @returns {{ docs: Map<string, object>, hashes: Map<string, string> }}
   */
  _getTenantRegistry(anonId) {
    if (!anonId || typeof anonId !== 'string') {
      throw new Error('Valid anonId is required for tenant isolation');
    }
    const cleanId = anonId.trim();
    if (!this.documents.has(cleanId)) {
      this.documents.set(cleanId, new Map());
      this.hashIndex.set(cleanId, new Map());
    }
    return {
      docs: this.documents.get(cleanId),
      hashes: this.hashIndex.get(cleanId),
    };
  }

  /**
   * Ingests a document, note, or file buffer into the user's private RAG index.
   *
   * @param {string} anonId - Anonymized user identifier
   * @param {string|Buffer|object} input - Text, note object, or binary buffer
   * @param {object} [options={}]
   * @param {string} [options.docId] - Optional custom document ID
   * @param {string} [options.title] - Document title or label
   * @param {string} [options.filename] - Original filename
   * @param {string} [options.mimeType] - MIME type
   * @param {number} [options.chunkSize] - Character size per chunk
   * @param {number} [options.chunkOverlap] - Overlap per chunk
   * @param {boolean} [options.overwrite=false] - If true, re-indexes existing document with same hash
   * @param {object} [options.metadata={}] - Custom user metadata
   * @returns {Promise<{ success: boolean, docId: string, title: string, chunkCount: number, hash: string, isDuplicate?: boolean, error?: string }>}
   */
  async addDocument(anonId, input, options = {}) {
    const { docs, hashes } = this._getTenantRegistry(anonId);

    let rawText = '';
    let contentForHashing = '';
    let title = options.title || options.filename || 'Untitled Document';
    let source = options.filename || options.title || 'document';
    let mimeType = options.mimeType || 'text/plain';

    // 1. Parse input types
    if (typeof input === 'string') {
      rawText = input;
      contentForHashing = input;
    } else if (Buffer.isBuffer(input)) {
      contentForHashing = input;
      const filename = options.filename || '';

      // Check if PDF
      if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
        const pdfResult = extractTextFromPdfBuffer(input);
        if (!pdfResult.ok) {
          return { success: false, error: pdfResult.error || 'Failed to extract PDF text' };
        }
        rawText = pdfResult.text || '';
      } else {
        // Use generic document extractor (DOCX, PPTX, XLSX, TXT, MD, etc.)
        const extracted = extractDocumentContent(input, mimeType, filename);
        if (extracted.ok && extracted.text) {
          rawText = extracted.text;
        } else if (extracted.isPdf) {
          const pdfResult = extractTextFromPdfBuffer(input);
          rawText = pdfResult.ok ? pdfResult.text || '' : '';
        } else {
          // Fallback to utf8 text conversion
          rawText = input.toString('utf8');
        }
      }
    } else if (input && typeof input === 'object') {
      // Structured note or object input { title, text|content, tags, metadata }
      title = input.title || title;
      source = input.source || input.title || source;
      rawText = input.text || input.content || '';
      contentForHashing = rawText;
      if (input.metadata) {
        options.metadata = { ...options.metadata, ...input.metadata };
      }
    }

    if (!rawText || !rawText.trim()) {
      return {
        success: false,
        error: 'Document content is empty or could not be extracted',
      };
    }

    // 2. Duplicate detection via SHA-256 hash
    const hash = computeContentHash(contentForHashing);
    const existingDocId = hashes.get(hash);

    if (existingDocId && !options.overwrite) {
      return {
        success: true,
        isDuplicate: true,
        docId: existingDocId,
        title: docs.get(existingDocId)?.title || title,
        chunkCount: docs.get(existingDocId)?.chunkCount || 0,
        hash,
        message: 'Document already indexed with identical content',
      };
    }

    // If overwriting existing document with same hash, clean old chunks first
    if (existingDocId && options.overwrite) {
      this.deleteDocument(anonId, existingDocId);
    }

    const docId = options.docId || `doc_${Date.now()}_${hash.slice(0, 8)}`;

    // 3. Smart chunking
    const chunks = chunkText(rawText, {
      docId,
      source,
      chunkSize: options.chunkSize,
      chunkOverlap: options.chunkOverlap,
      metadata: options.metadata || {},
    });

    if (chunks.length === 0) {
      return { success: false, error: 'No usable chunks generated from text' };
    }

    // 4. Batch compute embeddings
    const chunkTexts = chunks.map((c) => c.text);
    const embeddings = await this.embeddings.embedDocuments(chunkTexts);

    // 5. Store in partitioned RAG store
    const items = chunks.map((chunk, idx) => ({
      chunk,
      embedding: embeddings[idx] || [],
    }));

    this.store.addChunks(anonId, items);

    // 6. Record document metadata
    const docRecord = {
      docId,
      title,
      source,
      hash,
      charCount: rawText.length,
      chunkCount: chunks.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: options.metadata || {},
    };

    docs.set(docId, docRecord);
    hashes.set(hash, docId);

    privacyLog('info', 'RAG_DOCUMENT_INGESTED', {
      user: anonId,
      docId,
      chunks: chunks.length,
      charCount: rawText.length,
    });

    return {
      success: true,
      isDuplicate: false,
      docId,
      title,
      hash,
      chunkCount: chunks.length,
      charCount: rawText.length,
    };
  }

  /**
   * Searches the user's private documents using dense vector, BM25, or hybrid search.
   *
   * @param {string} anonId - Anonymized user identifier
   * @param {string} query - Natural language query
   * @param {object} [options={}]
   * @param {number} [options.topK=5] - Maximum chunks to return
   * @param {'hybrid'|'vector'|'keyword'} [options.mode='hybrid'] - Search algorithm
   * @param {number} [options.alpha=0.5] - Dense vs BM25 balance (1.0 = pure dense, 0.0 = pure sparse)
   * @param {Function|object} [options.filter=null] - Optional metadata filter
   * @returns {Promise<{ query: string, results: Array<object>, totalMatches: number }>}
   */
  async search(anonId, query, options = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { query: '', results: [], totalMatches: 0 };
    }

    const cleanQuery = query.trim();
    const mode = options.mode || 'hybrid';

    // Compute query embedding unless keyword-only search
    let queryEmbedding = [];
    if (mode !== 'keyword') {
      queryEmbedding = await this.embeddings.embedQuery(cleanQuery);
    }

    const matches = this.store.search(anonId, {
      query: cleanQuery,
      queryEmbedding,
      topK: options.topK || 5,
      mode,
      alpha: options.alpha !== undefined ? options.alpha : 0.5,
      filter: options.filter || null,
    });

    const results = matches.map((m) => ({
      id: m.chunk.id,
      docId: m.chunk.docId,
      text: m.chunk.text,
      source: m.chunk.source,
      page: m.chunk.page,
      chunkIndex: m.chunk.chunkIndex,
      score: m.score,
      denseScore: m.denseScore,
      bm25Score: m.bm25Score,
      rank: m.rank,
      metadata: m.chunk.metadata || {},
    }));

    return {
      query: cleanQuery,
      results,
      totalMatches: results.length,
    };
  }

  /**
   * Retrieves top relevant context chunks and formats a prompt ready for LLM consumption.
   *
   * @param {string} anonId
   * @param {string} query
   * @param {object} [options={}]
   * @returns {Promise<{ context: string, sources: Array<object>, hasContext: boolean }>}
   */
  async buildRagPrompt(anonId, query, options = {}) {
    const searchRes = await this.search(anonId, query, options);

    if (!searchRes.results || searchRes.results.length === 0) {
      return {
        context: '',
        sources: [],
        hasContext: false,
      };
    }

    const contextBlocks = searchRes.results.map((r, i) => {
      const pageInfo = r.page ? `, Page ${r.page}` : '';
      return `[Citation ${i + 1} | Source: "${r.source}"${pageInfo}]:\n${r.text}`;
    });

    const context = `Context from user's personal documents:\n\n${contextBlocks.join('\n\n')}`;

    return {
      context,
      sources: searchRes.results.map((r) => ({
        docId: r.docId,
        source: r.source,
        page: r.page,
        score: r.score,
      })),
      hasContext: true,
    };
  }

  /**
   * Deletes a document and all of its indexed chunks.
   *
   * @param {string} anonId
   * @param {string} docId
   * @returns {boolean} True if deleted
   */
  deleteDocument(anonId, docId) {
    const { docs, hashes } = this._getTenantRegistry(anonId);
    const doc = docs.get(docId);
    if (!doc) return false;

    // Delete chunks from store
    this.store.deleteChunksByDocId(anonId, docId);

    // Delete from registry and hash map
    if (doc.hash) {
      hashes.delete(doc.hash);
    }
    docs.delete(docId);

    privacyLog('info', 'RAG_DOCUMENT_DELETED', { user: anonId, docId });
    return true;
  }

  /**
   * Lists all indexed documents for a user.
   *
   * @param {string} anonId
   * @returns {Array<object>}
   */
  listDocuments(anonId) {
    const { docs } = this._getTenantRegistry(anonId);
    return Array.from(docs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Retrieves single document metadata by ID.
   *
   * @param {string} anonId
   * @param {string} docId
   * @returns {object|null}
   */
  getDocument(anonId, docId) {
    const { docs } = this._getTenantRegistry(anonId);
    return docs.get(docId) || null;
  }

  /**
   * Gets storage statistics for a user.
   *
   * @param {string} anonId
   * @returns {object}
   */
  getStats(anonId) {
    const storeStats = this.store.getStats(anonId);
    const { docs } = this._getTenantRegistry(anonId);
    return {
      ...storeStats,
      totalDocuments: docs.size,
    };
  }

  /**
   * Clears all documents and chunks for a user (Privacy & GDPR compliance).
   *
   * @param {string} anonId
   * @returns {boolean}
   */
  clearUser(anonId) {
    if (!anonId) return false;
    const cleanId = anonId.trim();
    this.store.deleteTenant(cleanId);
    this.documents.delete(cleanId);
    this.hashIndex.delete(cleanId);
    privacyLog('info', 'RAG_USER_CLEARED', { user: cleanId });
    return true;
  }

  /**
   * Completely resets all users and memory.
   */
  clearAll() {
    this.store.clear();
    this.documents.clear();
    this.hashIndex.clear();
  }
}

/**
 * Singleton Default Engine Instance
 */
export const ragEngine = new RagEngine();
