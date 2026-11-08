import AdmZip from 'adm-zip';
import { privacyLog } from './privacy.js';

/**
 * Standard Document MIME types supported by the assistant.
 */
export const SUPPORTED_DOCUMENT_MIMES = new Set([
  // PDF
  'application/pdf',
  // PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  // Excel
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // Plain text & structured formats
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'text/html',
  'application/xml',
  'text/xml',
]);

/**
 * Maps common file extensions to standardized MIME types.
 */
const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
};

/**
 * Infers or corrects the MIME type using the reported MIME and filename extension.
 *
 * @param {string} reportedMime - MIME reported by WhatsApp Cloud API
 * @param {string} [filename=''] - Original filename attached to message
 * @returns {string} Normalized MIME type
 */
export function resolveDocumentMime(reportedMime = '', filename = '') {
  const cleanMime = (reportedMime || '').trim().toLowerCase().split(';')[0];

  // If reported MIME is valid and specific, use it
  if (cleanMime && cleanMime !== 'application/octet-stream' && SUPPORTED_DOCUMENT_MIMES.has(cleanMime)) {
    return cleanMime;
  }

  // Fallback to filename extension
  if (filename) {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = filename.substring(lastDot).toLowerCase();
      if (EXTENSION_TO_MIME[ext]) {
        return EXTENSION_TO_MIME[ext];
      }
    }
  }

  return cleanMime || 'application/octet-stream';
}

/**
 * Checks whether a document format is supported.
 *
 * @param {string} mimeType
 * @param {string} [filename='']
 * @returns {boolean}
 */
export function isDocumentSupported(mimeType = '', filename = '') {
  const resolved = resolveDocumentMime(mimeType, filename);
  return SUPPORTED_DOCUMENT_MIMES.has(resolved);
}

/**
 * Extracts slides text from a PowerPoint (.pptx) file buffer in memory.
 *
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, text?: string, slideCount?: number, error?: string }}
 */
export function extractTextFromPptx(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    // Match slide XML files: ppt/slides/slide1.xml, ppt/slides/slide2.xml, etc.
    const slideEntries = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName));

    if (slideEntries.length === 0) {
      return { ok: false, error: 'No slides found in presentation archive' };
    }

    // Sort slides numerically
    slideEntries.sort((a, b) => {
      const matchA = a.entryName.match(/\d+/);
      const matchB = b.entryName.match(/\d+/);
      const numA = matchA ? parseInt(matchA[0], 10) : 0;
      const numB = matchB ? parseInt(matchB[0], 10) : 0;
      return numA - numB;
    });

    const slides = [];

    for (let i = 0; i < slideEntries.length; i++) {
      const entry = slideEntries[i];
      const xml = entry.getData().toString('utf8');

      const texts = [];
      const regex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const text = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (text) {
          texts.push(text);
        }
      }

      if (texts.length > 0) {
        slides.push(`--- Slide ${i + 1} ---\n${texts.join(' ')}`);
      } else {
        slides.push(`--- Slide ${i + 1} ---\n[Visual or diagram slide with no extractable text]`);
      }
    }

    return {
      ok: true,
      slideCount: slideEntries.length,
      text: slides.join('\n\n'),
    };
  } catch (err) {
    privacyLog('warn', 'PPTX_EXTRACTION_FAILED', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Extracts paragraphs from a Word (.docx) file buffer in memory.
 *
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, text?: string, error?: string }}
 */
export function extractTextFromDocx(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const docEntry = zip.getEntry('word/document.xml');

    if (!docEntry) {
      return { ok: false, error: 'word/document.xml not found in Word archive' };
    }

    const xml = docEntry.getData().toString('utf8');
    const paragraphs = [];
    const pRegex = /<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
    let pMatch;

    while ((pMatch = pRegex.exec(xml)) !== null) {
      const pXml = pMatch[1];
      const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
      let tMatch;
      const runs = [];

      while ((tMatch = tRegex.exec(pXml)) !== null) {
        runs.push(tMatch[1]);
      }

      const text = runs.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

      if (text) {
        paragraphs.push(text);
      }
    }

    return {
      ok: true,
      text: paragraphs.join('\n\n'),
    };
  } catch (err) {
    privacyLog('warn', 'DOCX_EXTRACTION_FAILED', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Extracts shared strings and cell data from an Excel (.xlsx) file buffer in memory.
 *
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, text?: string, error?: string }}
 */
export function extractTextFromXlsx(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const stringsEntry = zip.getEntry('xl/sharedStrings.xml');

    const sharedStrings = [];
    if (stringsEntry) {
      const xml = stringsEntry.getData().toString('utf8');
      const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let match;
      while ((match = tRegex.exec(xml)) !== null) {
        const val = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (val) sharedStrings.push(val);
      }
    }

    if (sharedStrings.length > 0) {
      return {
        ok: true,
        text: `Excel Spreadsheet Strings:\n${sharedStrings.join('\n')}`,
      };
    }

    return {
      ok: false,
      error: 'No readable text or shared strings found in Excel sheet',
    };
  } catch (err) {
    privacyLog('warn', 'XLSX_EXTRACTION_FAILED', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * General document text extraction dispatcher.
 * Handles PPTX, DOCX, XLSX, TXT, CSV, JSON, MD, HTML.
 * For PDF, returns { isPdf: true } indicating native multimodal handling.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} [filename='']
 * @returns {{ ok: boolean, isPdf?: boolean, text?: string, slideCount?: number, error?: string }}
 */
export function extractDocumentContent(buffer, mimeType, filename = '') {
  const resolvedMime = resolveDocumentMime(mimeType, filename);

  if (resolvedMime === 'application/pdf') {
    return { ok: true, isPdf: true };
  }

  // PPTX
  if (
    resolvedMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    (filename && filename.toLowerCase().endsWith('.pptx'))
  ) {
    return extractTextFromPptx(buffer);
  }

  // DOCX
  if (
    resolvedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    (filename && filename.toLowerCase().endsWith('.docx'))
  ) {
    return extractTextFromDocx(buffer);
  }

  // XLSX
  if (
    resolvedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    (filename && filename.toLowerCase().endsWith('.xlsx'))
  ) {
    return extractTextFromXlsx(buffer);
  }

  // Plain text, CSV, Markdown, JSON, XML, HTML
  if (
    resolvedMime === 'text/plain' ||
    resolvedMime === 'text/csv' ||
    resolvedMime === 'text/markdown' ||
    resolvedMime === 'text/x-markdown' ||
    resolvedMime === 'application/json' ||
    resolvedMime === 'text/html' ||
    resolvedMime === 'application/xml' ||
    resolvedMime === 'text/xml'
  ) {
    try {
      const text = buffer.toString('utf8').trim();
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    ok: false,
    error: `Unsupported document format (${resolvedMime || 'unknown'})`,
  };
}
