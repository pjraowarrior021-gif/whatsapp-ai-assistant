/**
 * In-Memory Vector & Inverted Keyword Index Store for Personal RAG Engine
 *
 * Implements:
 * 1. Multi-tenant in-memory partitioning (strictly partitioned by anonId).
 * 2. Dense vector similarity search (cosine similarity).
 * 3. Sparse keyword BM25 scoring with Okapi/Lucene formulation.
 * 4. Hybrid search via Reciprocal Rank Fusion (RRF) and weighted fusion.
 * 5. Full Document and Chunk CRUD with zero cross-user leakage.
 */

import { cosineSimilarity } from './embeddings.js';

/**
 * Tokenizes text for BM25 keyword matching.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForBm25(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.toLowerCase().replace(/[^a-z0-9_-]/g, ' ');
  return clean.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * In-memory storage partition for a single tenant (user).
 */
class TenantStore {
  constructor(anonId) {
    this.anonId = anonId;
    // Map<chunkId, { chunk: object, embedding: number[] }>
    this.chunks = new Map();
    // Map<docId, Set<chunkId>>
    this.docToChunks = new Map();
    // Map<term, Map<chunkId, termFreq>>
    this.invertedIndex = new Map();
    // Map<chunkId, number> (token length)
    this.chunkLengths = new Map();
    // Total tokens across all chunks
    this.totalTokens = 0;
  }

  /**
   * Average document token length.
   * @type {number}
   */
  get avgdl() {
    if (this.chunks.size === 0) return 1;
    return Math.max(1, this.totalTokens / this.chunks.size);
  }

  /**
   * Adds or replaces a chunk with its precomputed embedding.
   *
   * @param {object} chunk
   * @param {number[]} embedding
   */
  addChunk(chunk, embedding) {
    if (!chunk || !chunk.id) {
      throw new Error('Chunk must have a valid id');
    }

    // If chunk already exists, remove previous index entries first
    if (this.chunks.has(chunk.id)) {
      this.removeChunkIndex(chunk.id);
    }

    this.chunks.set(chunk.id, { chunk, embedding });

    // Track docId mapping
    const docId = chunk.docId || 'default';
    if (!this.docToChunks.has(docId)) {
      this.docToChunks.set(docId, new Set());
    }
    this.docToChunks.get(docId).add(chunk.id);

    // Index tokens for BM25
    const tokens = tokenizeForBm25(chunk.text);
    const tokenCount = tokens.length;
    this.chunkLengths.set(chunk.id, tokenCount);
    this.totalTokens += tokenCount;

    const termFreqs = new Map();
    for (const t of tokens) {
      termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
    }

    for (const [term, freq] of termFreqs.entries()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Map());
      }
      this.invertedIndex.get(term).set(chunk.id, freq);
    }
  }

  /**
   * Removes indexing structures for a chunk.
   *
   * @param {string} chunkId
   */
  removeChunkIndex(chunkId) {
    const existing = this.chunks.get(chunkId);
    if (!existing) return;

    const len = this.chunkLengths.get(chunkId) || 0;
    this.totalTokens = Math.max(0, this.totalTokens - len);
    this.chunkLengths.delete(chunkId);

    const docId = existing.chunk.docId || 'default';
    const docSet = this.docToChunks.get(docId);
    if (docSet) {
      docSet.delete(chunkId);
      if (docSet.size === 0) {
        this.docToChunks.delete(docId);
      }
    }

    // Clean inverted index
    for (const [term, postingMap] of this.invertedIndex.entries()) {
      if (postingMap.delete(chunkId)) {
        if (postingMap.size === 0) {
          this.invertedIndex.delete(term);
        }
      }
    }

    this.chunks.delete(chunkId);
  }

  /**
   * Deletes all chunks associated with a document ID.
   *
   * @param {string} docId
   * @returns {number} Number of chunks deleted
   */
  deleteByDocId(docId) {
    const chunkIds = this.docToChunks.get(docId);
    if (!chunkIds || chunkIds.size === 0) {
      return 0;
    }

    const idsToDelete = Array.from(chunkIds);
    for (const id of idsToDelete) {
      this.removeChunkIndex(id);
    }

    this.docToChunks.delete(docId);
    return idsToDelete.length;
  }

  /**
   * Computes BM25 keyword scores for all matching chunks.
   *
   * @param {string} query
   * @param {object} [options={}]
   * @returns {Map<string, number>} Map of chunkId -> BM25 score
   */
  scoreBm25(query, options = {}) {
    const k1 = options.k1 ?? 1.5;
    const b = options.b ?? 0.75;
    const scores = new Map();

    const queryTokens = tokenizeForBm25(query);
    if (queryTokens.length === 0 || this.chunks.size === 0) {
      return scores;
    }

    const N = this.chunks.size;
    const avgdl = this.avgdl;

    for (const q of queryTokens) {
      const postingMap = this.invertedIndex.get(q);
      if (!postingMap || postingMap.size === 0) continue;

      const n = postingMap.size;
      // Okapi BM25 standard IDF with smoothing
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));

      for (const [chunkId, freq] of postingMap.entries()) {
        const docLen = this.chunkLengths.get(chunkId) || 1;
        const numerator = freq * (k1 + 1);
        const denominator = freq + k1 * (1 - b + b * (docLen / avgdl));
        const termScore = idf * (numerator / denominator);

        scores.set(chunkId, (scores.get(chunkId) || 0) + termScore);
      }
    }

    return scores;
  }

  /**
   * Computes dense vector cosine similarity for all chunks.
   *
   * @param {number[]} queryEmbedding
   * @returns {Map<string, number>} Map of chunkId -> cosine score
   */
  scoreVector(queryEmbedding) {
    const scores = new Map();
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return scores;
    }

    for (const [chunkId, entry] of this.chunks.entries()) {
      if (Array.isArray(entry.embedding) && entry.embedding.length > 0) {
        const sim = cosineSimilarity(queryEmbedding, entry.embedding);
        scores.set(chunkId, sim);
      } else {
        scores.set(chunkId, 0);
      }
    }

    return scores;
  }

  /**
   * Applies metadata filter to candidate chunk IDs.
   *
   * @param {string} chunkId
   * @param {Function|object|null} filter
   * @returns {boolean}
   */
  matchesFilter(chunkId, filter) {
    if (!filter) return true;
    const entry = this.chunks.get(chunkId);
    if (!entry) return false;

    if (typeof filter === 'function') {
      return Boolean(filter(entry.chunk));
    }

    if (typeof filter === 'object') {
      for (const [key, val] of Object.entries(filter)) {
        if (key === 'docId' && entry.chunk.docId !== val) return false;
        if (key === 'source' && entry.chunk.source !== val) return false;
        if (key === 'page' && entry.chunk.page !== val) return false;
        if (entry.chunk.metadata && entry.chunk.metadata[key] !== val && val !== undefined) {
          return false;
        }
      }
      return true;
    }

    return true;
  }
}

/**
 * High-performance In-Memory Multi-Tenant RAG Store.
 */
export class RagStore {
  constructor() {
    // Map<anonId, TenantStore>
    this.tenants = new Map();
  }

  /**
   * Gets or creates the tenant partition.
   *
   * @param {string} anonId
   * @returns {TenantStore}
   */
  _getTenant(anonId, autoCreate = true) {
    if (!anonId || typeof anonId !== 'string') {
      throw new Error('Valid anonId is required for tenant isolation');
    }
    const cleanId = anonId.trim();
    if (!this.tenants.has(cleanId)) {
      if (!autoCreate) return null;
      this.tenants.set(cleanId, new TenantStore(cleanId));
    }
    return this.tenants.get(cleanId);
  }

  /**
   * Stores chunks with their embeddings for an isolated tenant.
   *
   * @param {string} anonId
   * @param {Array<{ chunk: object, embedding: number[] }>} items
   * @returns {number} Number of chunks added
   */
  addChunks(anonId, items) {
    const tenant = this._getTenant(anonId);
    if (!Array.isArray(items)) return 0;

    let count = 0;
    for (const item of items) {
      if (item && item.chunk) {
        tenant.addChunk(item.chunk, item.embedding || []);
        count++;
      }
    }
    return count;
  }

  /**
   * Retrieves a single chunk by ID.
   *
   * @param {string} anonId
   * @param {string} chunkId
   * @returns {object|null}
   */
  getChunk(anonId, chunkId) {
    const tenant = this._getTenant(anonId, false);
    if (!tenant) return null;
    const entry = tenant.chunks.get(chunkId);
    return entry ? entry.chunk : null;
  }

  /**
   * Retrieves all chunks for a specific document ID.
   *
   * @param {string} anonId
   * @param {string} docId
   * @returns {Array<object>}
   */
  getChunksByDocId(anonId, docId) {
    const tenant = this._getTenant(anonId, false);
    if (!tenant) return [];
    const chunkIds = tenant.docToChunks.get(docId);
    if (!chunkIds) return [];

    const results = [];
    for (const id of chunkIds) {
      const entry = tenant.chunks.get(id);
      if (entry) results.push(entry.chunk);
    }
    return results;
  }

  /**
   * Deletes all chunks belonging to a document ID.
   *
   * @param {string} anonId
   * @param {string} docId
   * @returns {number} Deleted chunk count
   */
  deleteChunksByDocId(anonId, docId) {
    const tenant = this._getTenant(anonId, false);
    if (!tenant) return 0;
    return tenant.deleteByDocId(docId);
  }

  /**
   * Performs hybrid search, vector search, or keyword search across tenant chunks.
   *
   * @param {string} anonId
   * @param {object} options
   * @param {string} [options.query='']
   * @param {number[]} [options.queryEmbedding=[]]
   * @param {number} [options.topK=5]
   * @param {'hybrid'|'vector'|'keyword'} [options.mode='hybrid']
   * @param {number} [options.alpha=0.5] - Dense vs sparse weight (1.0 = pure dense, 0.0 = pure sparse)
   * @param {number} [options.rrfK=60] - RRF smoothing parameter
   * @param {Function|object} [options.filter=null] - Metadata filter
   * @returns {Array<{ chunk: object, score: number, denseScore: number, bm25Score: number, rank: number }>}
   */
  search(anonId, options = {}) {
    const tenant = this._getTenant(anonId, false);
    if (!tenant || tenant.chunks.size === 0) {
      return [];
    }

    const {
      query = '',
      queryEmbedding = [],
      topK = 5,
      mode = 'hybrid',
      alpha = 0.5,
      rrfK = 60,
      filter = null,
    } = options;

    const clampedTopK = Math.max(1, topK);
    const clampedAlpha = Math.max(0, Math.min(1, alpha));

    // Vector similarity scores
    const denseScores =
      mode === 'keyword' || !queryEmbedding || queryEmbedding.length === 0
        ? new Map()
        : tenant.scoreVector(queryEmbedding);

    // BM25 keyword scores
    const sparseScores = mode === 'vector' || !query ? new Map() : tenant.scoreBm25(query);

    // Collect all candidate chunk IDs that match the filter and have relevance
    const candidateIds = new Set();
    for (const [chunkId] of tenant.chunks.entries()) {
      if (tenant.matchesFilter(chunkId, filter)) {
        const d = denseScores.get(chunkId) ?? -1;
        const s = sparseScores.get(chunkId) ?? 0;

        if (mode === 'vector' && d > 0) {
          candidateIds.add(chunkId);
        } else if (mode === 'keyword' && s > 0) {
          candidateIds.add(chunkId);
        } else if (mode === 'hybrid') {
          // Include if positive signal from dense or sparse
          if (d > 0 || s > 0) {
            candidateIds.add(chunkId);
          }
        }
      }
    }

    if (candidateIds.size === 0) {
      return [];
    }

    // Rank candidate IDs by dense score
    const denseRanked = Array.from(candidateIds)
      .map((id) => ({ id, score: denseScores.get(id) ?? -1 }))
      .sort((a, b) => b.score - a.score);

    const denseRankMap = new Map();
    denseRanked.forEach((item, idx) => {
      // 1-based rank
      denseRankMap.set(item.id, idx + 1);
    });

    // Rank candidate IDs by sparse BM25 score
    const sparseRanked = Array.from(candidateIds)
      .map((id) => ({ id, score: sparseScores.get(id) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const sparseRankMap = new Map();
    sparseRanked.forEach((item, idx) => {
      sparseRankMap.set(item.id, idx + 1);
    });

    // Compute final fusion score
    const results = [];
    const denseWeight = clampedAlpha;
    const sparseWeight = 1.0 - clampedAlpha;

    for (const chunkId of candidateIds) {
      const entry = tenant.chunks.get(chunkId);
      if (!entry) continue;

      const dScore = denseScores.get(chunkId) ?? 0;
      const sScore = sparseScores.get(chunkId) ?? 0;

      let finalScore = 0;

      if (mode === 'vector') {
        finalScore = dScore;
      } else if (mode === 'keyword') {
        finalScore = sScore;
      } else {
        // Reciprocal Rank Fusion (RRF)
        const dRank = denseRankMap.get(chunkId) || candidateIds.size + 1;
        const sRank = sparseRankMap.get(chunkId) || candidateIds.size + 1;

        const rrfDense = denseWeight / (rrfK + dRank);
        const rrfSparse = sparseWeight / (rrfK + sRank);
        finalScore = rrfDense + rrfSparse;
      }

      results.push({
        chunk: entry.chunk,
        score: finalScore,
        denseScore: dScore,
        bm25Score: sScore,
      });
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, clampedTopK).map((r, idx) => ({
      ...r,
      rank: idx + 1,
    }));
  }

  /**
   * Deletes all data for a specific user tenant (Privacy & GDPR compliance).
   *
   * @param {string} anonId
   * @returns {boolean} True if tenant existed and was deleted
   */
  deleteTenant(anonId) {
    if (!anonId) return false;
    return this.tenants.delete(anonId.trim());
  }

  /**
   * Gets tenant storage statistics.
   *
   * @param {string} anonId
   * @returns {{ totalDocuments: number, totalChunks: number, totalTerms: number, avgDocLength: number }}
   */
  getStats(anonId) {
    const tenant = this._getTenant(anonId, false);
    if (!tenant) {
      return { totalDocuments: 0, totalChunks: 0, totalTerms: 0, avgDocLength: 0 };
    }

    return {
      totalDocuments: tenant.docToChunks.size,
      totalChunks: tenant.chunks.size,
      totalTerms: tenant.invertedIndex.size,
      avgDocLength: Math.round(tenant.avgdl),
    };
  }

  /**
   * Resets all tenant stores.
   */
  clear() {
    this.tenants.clear();
  }
}
