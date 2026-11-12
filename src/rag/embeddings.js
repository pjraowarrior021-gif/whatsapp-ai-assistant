/**
 * Pluggable Embedding Provider Abstraction for Personal RAG Engine
 *
 * Supports:
 * 1. Local TF-IDF / Feature-Hashed Vectorization (deterministic, zero-dependency, normalized).
 * 2. Google Gemini `text-embedding-004` (optional, falls back gracefully if absent or failing).
 * 3. High-performance Cosine Distance & Normalization utilities.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { privacyLog } from '../privacy.js';

/**
 * Standard English Stopwords to filter out during local sparse vectorization.
 */
export const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'aren',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'couldn',
  'did',
  'didn',
  'do',
  'does',
  'doesn',
  'doing',
  'don',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'hadn',
  'has',
  'hasn',
  'have',
  'haven',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'isn',
  'it',
  'its',
  'itself',
  'just',
  'll',
  'm',
  'me',
  'might',
  'more',
  'most',
  'must',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'o',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  're',
  's',
  'same',
  'shan',
  'she',
  'should',
  'shouldn',
  'so',
  'some',
  'such',
  't',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  've',
  'very',
  'was',
  'wasn',
  'we',
  'were',
  'weren',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'won',
  'would',
  'wouldn',
  'y',
  'you',
  'your',
  'yours',
  'yourself',
]);

/**
 * Fast 32-bit FNV-1a hash algorithm for deterministic feature hashing.
 *
 * @param {string} str - String to hash
 * @returns {number} Unsigned 32-bit integer
 */
export function fnv1a(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Normalizes a vector to unit Euclidean norm (L2 = 1.0).
 *
 * @param {number[]} vec
 * @returns {number[]} Normalized vector
 */
export function normalizeVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return [];

  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }

  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) {
    return new Array(vec.length).fill(0);
  }

  const normalized = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    normalized[i] = vec[i] / norm;
  }
  return normalized;
}

/**
 * Computes the cosine similarity between two numeric vectors.
 * Returns a value in [-1.0, 1.0].
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} Cosine similarity
 */
export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
    return 0;
  }
  if (vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normASq = 0;
  let normBSq = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normASq += a * a;
    normBSq += b * b;
  }

  const denominator = Math.sqrt(normASq) * Math.sqrt(normBSq);
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return 0;
  }

  const sim = dotProduct / denominator;
  return Math.max(-1, Math.min(1, sim));
}

/**
 * Base Embedding Provider
 */
export class EmbeddingProvider {
  /**
   * Vector dimension size.
   * @type {number}
   */
  get dimension() {
    return 256;
  }

  /**
   * Embeds a single query string.
   * @param {string} _text
   * @returns {Promise<number[]>}
   */
  async embedQuery(_text) {
    throw new Error('embedQuery must be implemented by subclass');
  }

  /**
   * Embeds multiple document text chunks.
   * @param {string[]} _texts
   * @returns {Promise<number[][]>}
   */
  async embedDocuments(_texts) {
    throw new Error('embedDocuments must be implemented by subclass');
  }
}

/**
 * Local TF-IDF & Feature-Hashed Embedding Provider.
 * Deterministic, offline, and zero external dependency.
 */
export class LocalTfIdfEmbeddings extends EmbeddingProvider {
  /**
   * @param {object} [options={}]
   * @param {number} [options.dimension=256] - Output vector length
   */
  constructor(options = {}) {
    super();
    this._dimension = Math.max(32, options.dimension || 256);
  }

  get dimension() {
    return this._dimension;
  }

  /**
   * Tokenizes and extracts unigrams and bigrams from raw text.
   *
   * @param {string} text
   * @returns {string[]}
   */
  tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    const clean = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ');
    const rawTokens = clean.split(/\s+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t));

    const features = [...rawTokens];
    // Add bigram features for phrase semantics
    for (let i = 0; i < rawTokens.length - 1; i++) {
      features.push(`${rawTokens[i]}_${rawTokens[i + 1]}`);
    }

    return features;
  }

  /**
   * Converts tokens to a normalized feature-hashed vector.
   *
   * @param {string} text
   * @returns {number[]}
   */
  vectorize(text) {
    const vector = new Array(this._dimension).fill(0);
    const tokens = this.tokenize(text);

    if (tokens.length === 0) {
      return vector;
    }

    // Count term frequencies
    const tfMap = new Map();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }

    for (const [token, count] of tfMap.entries()) {
      const hash = fnv1a(token);
      const bucket = hash % this._dimension;
      // Second hash bit for signed hashing trick (reduces collision bias)
      const signHash = fnv1a(`${token}:sign`);
      const sign = (signHash & 1) === 1 ? 1 : -1;

      // Sublinear term frequency weighting: 1 + ln(count)
      const weight = 1 + Math.log(count);
      vector[bucket] += sign * weight;
    }

    return normalizeVector(vector);
  }

  async embedQuery(text) {
    return this.vectorize(text);
  }

  async embedDocuments(texts) {
    if (!Array.isArray(texts)) return [];
    return texts.map((t) => this.vectorize(t));
  }
}

/**
 * Gemini Embedding Provider
 * Integrates with Google Gemini `text-embedding-004`.
 * Hermetic: falls back to LocalTfIdfEmbeddings when API key is missing or calls fail.
 */
export class GeminiEmbeddings extends EmbeddingProvider {
  /**
   * @param {object} [options={}]
   * @param {string} [options.apiKey]
   * @param {string} [options.model='text-embedding-004']
   * @param {EmbeddingProvider} [options.fallbackProvider]
   */
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || config.GEMINI_API_KEY || '';
    this.modelName = options.model || 'text-embedding-004';
    this.fallback = options.fallbackProvider || new LocalTfIdfEmbeddings({ dimension: 768 });
    this._client = null;

    if (this.apiKey) {
      try {
        this._client = new GoogleGenAI({ apiKey: this.apiKey });
      } catch (err) {
        privacyLog('warn', 'GEMINI_CLIENT_INIT_FAILED', { error: err.message });
      }
    }
  }

  get dimension() {
    return 768;
  }

  async embedQuery(text) {
    if (!this._client || !this.apiKey) {
      return this.fallback.embedQuery(text);
    }

    try {
      const response = await this._client.models.embedContent({
        model: this.modelName,
        contents: text,
      });

      const values = response?.embedding?.values;
      if (Array.isArray(values) && values.length > 0) {
        return normalizeVector(values);
      }
      return this.fallback.embedQuery(text);
    } catch (err) {
      privacyLog('warn', 'GEMINI_EMBED_QUERY_FALLBACK', { error: err.message });
      return this.fallback.embedQuery(text);
    }
  }

  async embedDocuments(texts) {
    if (!Array.isArray(texts)) return [];
    if (!this._client || !this.apiKey) {
      return this.fallback.embedDocuments(texts);
    }

    try {
      const results = [];
      // Process in batches of 10 to respect API rate limits
      const batchSize = 10;
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchPromises = batch.map(async (text) => {
          try {
            const resp = await this._client.models.embedContent({
              model: this.modelName,
              contents: text,
            });
            const values = resp?.embedding?.values;
            if (Array.isArray(values) && values.length > 0) {
              return normalizeVector(values);
            }
            return this.fallback.vectorize(text);
          } catch {
            return this.fallback.vectorize(text);
          }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }

      return results;
    } catch (err) {
      privacyLog('warn', 'GEMINI_EMBED_DOCS_FALLBACK', { error: err.message });
      return this.fallback.embedDocuments(texts);
    }
  }
}

/**
 * Factory to create an embedding provider based on configuration.
 *
 * @param {'local'|'gemini'} [type='local']
 * @param {object} [options={}]
 * @returns {EmbeddingProvider}
 */
export function createEmbeddingProvider(type = 'local', options = {}) {
  const normalized = (type || 'local').toLowerCase().trim();
  if (normalized === 'gemini') {
    return new GeminiEmbeddings(options);
  }
  return new LocalTfIdfEmbeddings(options);
}
