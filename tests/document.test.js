import test from 'node:test';
import assert from 'node:assert';
import AdmZip from 'adm-zip';
import {
  isDocumentSupported,
  resolveDocumentMime,
  extractTextFromPptx,
  extractTextFromDocx,
  extractTextFromXlsx,
  extractDocumentContent,
  SUPPORTED_DOCUMENT_MIMES,
} from '../src/document.js';

test('Document: isDocumentSupported identifies supported formats and extensions', () => {
  // Direct MIMEs
  assert.strictEqual(isDocumentSupported('application/pdf'), true);
  assert.strictEqual(
    isDocumentSupported('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    true
  );
  assert.strictEqual(
    isDocumentSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    true
  );
  assert.strictEqual(isDocumentSupported('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  assert.strictEqual(isDocumentSupported('text/plain'), true);
  assert.strictEqual(isDocumentSupported('text/csv'), true);

  // Filename extension fallback when MIME is generic octet-stream
  assert.strictEqual(isDocumentSupported('application/octet-stream', 'IECE_Module_1.pptx'), true);
  assert.strictEqual(isDocumentSupported('application/octet-stream', 'report.docx'), true);
  assert.strictEqual(isDocumentSupported('application/octet-stream', 'data.xlsx'), true);
  assert.strictEqual(isDocumentSupported('application/octet-stream', 'document.pdf'), true);

  // Unsupported formats
  assert.strictEqual(isDocumentSupported('application/zip', 'archive.zip'), false);
  assert.strictEqual(isDocumentSupported('application/x-msdownload', 'malware.exe'), false);
  assert.strictEqual(isDocumentSupported('audio/mpeg', 'song.mp3'), false);

  // Set exports
  assert.ok(SUPPORTED_DOCUMENT_MIMES.size >= 10);
});

test('Document: resolveDocumentMime resolves and normalizes MIMEs', () => {
  assert.strictEqual(resolveDocumentMime('application/pdf; charset=binary'), 'application/pdf');
  assert.strictEqual(
    resolveDocumentMime('application/octet-stream', 'lecture.pptx'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
  assert.strictEqual(resolveDocumentMime('', 'data.csv'), 'text/csv');
  assert.strictEqual(
    resolveDocumentMime('', 'document.docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
});

test('Document: extractTextFromPptx extracts slides in numerical order', () => {
  const zip = new AdmZip();
  zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sp><a:p><a:t>Slide 2: Advanced Topics</a:t></a:p></p:sp>'));
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from('<p:sp><a:p><a:t>Slide 1: Intro</a:t></a:p><a:p><a:t>Overview bullet</a:t></a:p></p:sp>')
  );
  zip.addFile('ppt/slides/slide10.xml', Buffer.from('<p:sp><a:p><a:t>Slide 10: Conclusion</a:t></a:p></p:sp>'));

  const buffer = zip.toBuffer();
  const res = extractTextFromPptx(buffer);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.slideCount, 3);
  // Must be sorted slide1, slide2, slide10 (not alphabetical 1, 10, 2)
  const firstSlideIdx = res.text.indexOf('Slide 1: Intro');
  const secondSlideIdx = res.text.indexOf('Slide 2: Advanced Topics');
  const tenthSlideIdx = res.text.indexOf('Slide 10: Conclusion');

  assert.ok(firstSlideIdx !== -1);
  assert.ok(secondSlideIdx !== -1);
  assert.ok(tenthSlideIdx !== -1);
  assert.ok(firstSlideIdx < secondSlideIdx);
  assert.ok(secondSlideIdx < tenthSlideIdx);
});

test('Document: extractTextFromDocx extracts paragraphs', () => {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<w:document><w:body><w:p><w:r><w:t>Chapter 1</w:t></w:r></w:p><w:p><w:r><w:t>This is paragraph text.</w:t></w:r></w:p></w:body></w:document>'
    )
  );

  const buffer = zip.toBuffer();
  const res = extractTextFromDocx(buffer);

  assert.strictEqual(res.ok, true);
  assert.ok(res.text.includes('Chapter 1'));
  assert.ok(res.text.includes('This is paragraph text.'));
});

test('Document: extractTextFromXlsx extracts shared strings', () => {
  const zip = new AdmZip();
  zip.addFile(
    'xl/sharedStrings.xml',
    Buffer.from('<sst><si><t>Revenue Q1</t></si><si><t>Expenses Q1</t></si><si><t>Net Income</t></si></sst>')
  );

  const buffer = zip.toBuffer();
  const res = extractTextFromXlsx(buffer);

  assert.strictEqual(res.ok, true);
  assert.ok(res.text.includes('Revenue Q1'));
  assert.ok(res.text.includes('Expenses Q1'));
  assert.ok(res.text.includes('Net Income'));
});

test('Document: extractDocumentContent handles PDF and plain text', () => {
  // PDF
  const pdfRes = extractDocumentContent(Buffer.from('%PDF-1.4...'), 'application/pdf', 'sample.pdf');
  assert.strictEqual(pdfRes.ok, true);
  assert.strictEqual(pdfRes.isPdf, true);

  // TXT
  const txtRes = extractDocumentContent(Buffer.from('Hello world plain text'), 'text/plain', 'note.txt');
  assert.strictEqual(txtRes.ok, true);
  assert.strictEqual(txtRes.text, 'Hello world plain text');

  // CSV
  const csvRes = extractDocumentContent(Buffer.from('name,age\nAlice,30\nBob,25'), 'text/csv', 'data.csv');
  assert.strictEqual(csvRes.ok, true);
  assert.strictEqual(csvRes.text, 'name,age\nAlice,30\nBob,25');
});
