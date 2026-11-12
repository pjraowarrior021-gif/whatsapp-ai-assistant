/**
 * Smart Text Chunker for Personal RAG Engine
 *
 * Implements sentence-boundary and paragraph-aware text chunking with
 * configurable chunk size, overlap, page tracking, and rich metadata preservation.
 */

/**
 * Default chunking parameters
 */
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;

/**
 * Standard page delimiter patterns (PDF form-feed or explicit page markers)
 */
const PAGE_MARKER_REGEX =
  /(?:\f|(?:^|\n)\s*[-=_]{3,}\s*(?:Page|PAGE)\s*(\d+)\s*[-=_]{3,}|(?:^|\n)<!--\s*page\s*(\d+)\s*-->)/i;

/**
 * Splits text into sentence/clause segments while keeping boundary delimiters.
 *
 * @param {string} text - Input text block
 * @returns {string[]} Array of sentences/segments
 */
export function splitIntoSentences(text) {
  if (!text || typeof text !== 'string') return [];

  // Match sentences ending in ., !, ?, followed by whitespace or end of string,
  // or newline boundaries, while handling abbreviations safely.
  const rawSegments = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201C\u2018])|\n{2,}/g);
  const segments = [];

  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }

  return segments;
}

/**
 * Breaks a long segment that exceeds chunkSize into word-level subsegments.
 *
 * @param {string} segment - Segment string
 * @param {number} maxLen - Maximum character length
 * @returns {string[]} Subsegments
 */
function breakLongSegment(segment, maxLen) {
  if (segment.length <= maxLen) return [segment];

  const words = segment.split(/\s+/);
  const chunks = [];
  let current = '';

  for (const word of words) {
    // If a single word is longer than maxLen, hard-slice it
    if (word.length > maxLen) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxLen) {
        chunks.push(word.slice(i, i + maxLen));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Finds a natural break point (sentence or word boundary) near the target overlap index.
 *
 * @param {string} text - Chunk text
 * @param {number} overlapSize - Desired character overlap count
 * @returns {string} Overlap prefix for the subsequent chunk
 */
function extractOverlapPrefix(text, overlapSize) {
  if (!text || overlapSize <= 0) return '';
  if (text.length <= overlapSize) return text;

  // Extract the tail slice
  const tail = text.slice(-overlapSize);

  // Look for a whitespace boundary in the tail to avoid splitting words
  const spaceIndex = tail.indexOf(' ');
  if (spaceIndex !== -1 && spaceIndex < tail.length - 1) {
    return tail.slice(spaceIndex + 1).trim();
  }

  return tail.trim();
}

/**
 * Chunks a single text string into metadata-preserved chunk objects.
 *
 * @param {string} text - Raw document text
 * @param {object} [options={}] - Chunking options
 * @param {string} [options.docId=''] - Parent document identifier
 * @param {string} [options.source='unknown'] - Source name / filename
 * @param {number} [options.page=1] - Base page number
 * @param {number} [options.chunkSize=DEFAULT_CHUNK_SIZE] - Maximum chunk character count
 * @param {number} [options.chunkOverlap=DEFAULT_CHUNK_OVERLAP] - Overlap character count
 * @param {number} [options.timestamp=Date.now()] - Creation timestamp
 * @param {object} [options.metadata={}] - Custom user metadata
 * @returns {Array<object>} Array of chunk objects
 */
export function chunkText(text, options = {}) {
  if (!text || typeof text !== 'string') return [];

  const trimmedText = text.trim();
  if (trimmedText.length === 0) return [];

  const docId = options.docId || `doc_${Date.now()}`;
  const source = options.source || 'unknown';
  let currentPage = typeof options.page === 'number' && options.page > 0 ? options.page : 1;
  const chunkSize = Math.max(50, options.chunkSize || DEFAULT_CHUNK_SIZE);
  const chunkOverlap = Math.min(Math.max(0, options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP), Math.floor(chunkSize / 2));
  const timestamp = options.timestamp || Date.now();
  const baseMetadata = options.metadata || {};

  // Check if text has page break markers (e.g. form-feeds \f or "--- Page X ---")
  if (PAGE_MARKER_REGEX.test(text)) {
    return chunkPageDelimitedText(text, {
      ...options,
      docId,
      source,
      chunkSize,
      chunkOverlap,
      timestamp,
      baseMetadata,
    });
  }

  // Break text into sentences/paragraphs
  const segments = splitIntoSentences(trimmedText);
  const refinedSegments = [];

  for (const seg of segments) {
    if (seg.length > chunkSize) {
      refinedSegments.push(...breakLongSegment(seg, chunkSize));
    } else {
      refinedSegments.push(seg);
    }
  }

  const rawChunks = [];
  let currentBuffer = '';

  for (const seg of refinedSegments) {
    const candidate = currentBuffer ? `${currentBuffer}\n\n${seg}` : seg;

    if (candidate.length <= chunkSize) {
      currentBuffer = candidate;
    } else {
      if (currentBuffer.length > 0) {
        rawChunks.push(currentBuffer);

        // Compute overlap prefix
        const overlap = extractOverlapPrefix(currentBuffer, chunkOverlap);
        currentBuffer = overlap ? `${overlap}\n\n${seg}` : seg;

        // If even with overlap the single segment exceeds chunkSize (rare), force split
        if (currentBuffer.length > chunkSize) {
          const broken = breakLongSegment(currentBuffer, chunkSize);
          for (let i = 0; i < broken.length - 1; i++) {
            rawChunks.push(broken[i]);
          }
          currentBuffer = broken[broken.length - 1] || '';
        }
      } else {
        // Single segment exceeds buffer from empty
        rawChunks.push(seg);
        currentBuffer = '';
      }
    }
  }

  if (currentBuffer.length > 0) {
    rawChunks.push(currentBuffer);
  }

  // Build structured chunk objects
  const totalChunks = rawChunks.length;
  return rawChunks.map((content, idx) => ({
    id: `${docId}_chunk_${idx}`,
    docId,
    chunkIndex: idx,
    totalChunks,
    text: content.trim(),
    charCount: content.trim().length,
    page: currentPage,
    source,
    timestamp,
    metadata: { ...baseMetadata },
  }));
}

/**
 * Handles texts containing explicit page markers or form feed delimiters.
 *
 * @param {string} text
 * @param {object} opts
 * @returns {Array<object>}
 */
function chunkPageDelimitedText(text, opts) {
  // Split on form feeds or explicit page boundaries
  const parts = text.split(
    /(?=\f|(?:^|\n)\s*[-=_]{3,}\s*(?:Page|PAGE)\s*\d+\s*[-=_]{3,}|(?:^|\n)<!--\s*page\s*\d+\s*-->)/i
  );
  const allChunks = [];
  let pageCounter = opts.page || 1;

  for (const part of parts) {
    if (!part.trim()) continue;

    // Detect if part starts with a page number indicator
    const match = part.match(/(?:Page|PAGE)\s*(\d+)/i) || part.match(/<!--\s*page\s*(\d+)\s*-->/i);
    if (match) {
      pageCounter = parseInt(match[1], 10);
    }

    // Clean out the form feed / marker line for clean chunk text
    const cleanedText = part
      .replace(/\f/g, '')
      .replace(/(?:^|\n)\s*[-=_]{3,}\s*(?:Page|PAGE)\s*\d+\s*[-=_]{3,}/gi, '')
      .replace(/(?:^|\n)<!--\s*page\s*\d+\s*-->/gi, '')
      .trim();

    if (!cleanedText) {
      pageCounter++;
      continue;
    }

    const pageChunks = chunkText(cleanedText, {
      ...opts,
      page: pageCounter,
      metadata: { ...opts.baseMetadata, page: pageCounter },
    });

    allChunks.push(...pageChunks);
    pageCounter++;
  }

  // Re-index all chunks globally
  const total = allChunks.length;
  return allChunks.map((c, i) => ({
    ...c,
    id: `${opts.docId}_chunk_${i}`,
    chunkIndex: i,
    totalChunks: total,
  }));
}

/**
 * Chunks a collection of pre-delimited page objects.
 *
 * @param {Array<{ page: number, text: string }>} pages - Array of page objects
 * @param {object} options - Chunking options
 * @returns {Array<object>}
 */
export function chunkPages(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) return [];

  const allChunks = [];
  const docId = options.docId || `doc_${Date.now()}`;

  for (const pageObj of pages) {
    if (!pageObj || !pageObj.text) continue;
    const pageNum = pageObj.page || 1;
    const chunks = chunkText(pageObj.text, {
      ...options,
      docId,
      page: pageNum,
      metadata: { ...(options.metadata || {}), page: pageNum },
    });
    allChunks.push(...chunks);
  }

  const total = allChunks.length;
  return allChunks.map((c, i) => ({
    ...c,
    id: `${docId}_chunk_${i}`,
    chunkIndex: i,
    totalChunks: total,
  }));
}
