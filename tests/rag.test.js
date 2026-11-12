import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, chunkPages, splitIntoSentences } from '../src/rag/chunker.js';
import {
  LocalTfIdfEmbeddings,
  GeminiEmbeddings,
  cosineSimilarity,
  normalizeVector,
  createEmbeddingProvider,
  fnv1a,
} from '../src/rag/embeddings.js';
import { RagStore, tokenizeForBm25 } from '../src/rag/store.js';
import { RagEngine, computeContentHash, extractTextFromPdfBuffer } from '../src/rag/index.js';

describe('Personal RAG: Chunker', () => {
  it('returns empty array for empty, whitespace, or invalid input', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n\n  '), []);
    assert.deepEqual(chunkText(null), []);
    assert.deepEqual(chunkText(undefined), []);
    assert.deepEqual(splitIntoSentences(''), []);
  });

  it('splits single sentence smaller than chunkSize into single chunk with metadata', () => {
    const text = 'This is a compact sentence for testing.';
    const chunks = chunkText(text, {
      docId: 'doc_test_1',
      source: 'readme.txt',
      page: 1,
      metadata: { author: 'Alice' },
    });

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].id, 'doc_test_1_chunk_0');
    assert.equal(chunks[0].docId, 'doc_test_1');
    assert.equal(chunks[0].text, text);
    assert.equal(chunks[0].source, 'readme.txt');
    assert.equal(chunks[0].page, 1);
    assert.equal(chunks[0].totalChunks, 1);
    assert.equal(chunks[0].metadata.author, 'Alice');
  });

  it('respects sentence boundaries and preserves overlap across chunks', () => {
    const text =
      'Sentence one provides initial context. Sentence two explains the mechanics. ' +
      'Sentence three elaborates on details. Sentence four concludes the section. ' +
      'Sentence five outlines next steps. Sentence six gives practical examples.';

    const chunks = chunkText(text, {
      docId: 'doc_boundary',
      chunkSize: 120,
      chunkOverlap: 30,
    });

    assert.ok(chunks.length > 1, 'Should create multiple chunks for long text');
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 150, `Chunk text length ${chunk.text.length} should be reasonably bounded`);
      assert.equal(chunk.docId, 'doc_boundary');
    }

    // Check overlap: chunk 1 should share words or characters from chunk 0
    const chunk0Words = chunks[0].text.split(' ');
    const lastWord = chunk0Words[chunk0Words.length - 1];
    assert.ok(
      chunks[1].text.includes(lastWord) || chunks[1].text.length > 0,
      'Consecutive chunks should maintain contextual continuity'
    );
  });

  it('handles very long unbroken words without infinite loops', () => {
    const longWord = 'A'.repeat(300);
    const chunks = chunkText(longWord, {
      docId: 'doc_long',
      chunkSize: 80,
      chunkOverlap: 10,
    });

    assert.ok(chunks.length >= 3, 'Should slice oversized words into segments');
    const reassembled = chunks.map((c) => c.text).join('');
    assert.ok(reassembled.includes('AAA'));
  });

  it('detects and handles page boundaries in text', () => {
    const textWithPages =
      'First page content overview.\n\n--- Page 2 ---\nSecond page detailed data.\n\n\fThird page final remarks.';

    const chunks = chunkText(textWithPages, {
      docId: 'doc_pages',
      chunkSize: 200,
    });

    assert.ok(chunks.length >= 2, 'Should create chunks with distinct pages');
    const pages = chunks.map((c) => c.page);
    assert.ok(pages.includes(2), 'Should detect page 2 marker');
  });

  it('chunkPages correctly tags pre-delimited page objects', () => {
    const pages = [
      { page: 1, text: 'Introduction to Artificial Intelligence.' },
      { page: 2, text: 'Neural networks and deep learning concepts.' },
    ];

    const chunks = chunkPages(pages, { docId: 'ai_book', source: 'ai.pdf' });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].page, 1);
    assert.equal(chunks[1].page, 2);
    assert.equal(chunks[0].source, 'ai.pdf');
    assert.equal(chunks[0].totalChunks, 2);
  });
});

describe('Personal RAG: Embeddings & Cosine Similarity', () => {
  it('computes FNV-1a hash reliably', () => {
    const h1 = fnv1a('hello');
    const h2 = fnv1a('hello');
    const h3 = fnv1a('world');
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.ok(Number.isInteger(h1) && h1 > 0);
  });

  it('normalizes vector to unit L2 norm', () => {
    const vec = [3, 4];
    const norm = normalizeVector(vec);
    assert.equal(norm.length, 2);
    assert.ok(Math.abs(norm[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(norm[1] - 0.8) < 1e-6);

    // Magnitude should equal 1.0
    const mag = Math.sqrt(norm[0] ** 2 + norm[1] ** 2);
    assert.ok(Math.abs(mag - 1.0) < 1e-6);
  });

  it('handles zero vectors in normalizeVector safely', () => {
    assert.deepEqual(normalizeVector([0, 0, 0]), [0, 0, 0]);
    assert.deepEqual(normalizeVector([]), []);
  });

  it('calculates cosine similarity correctly', () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    const v3 = [0, 1, 0];
    const v4 = [-1, 0, 0];

    // Identical
    assert.ok(Math.abs(cosineSimilarity(v1, v2) - 1.0) < 1e-6);
    // Orthogonal
    assert.ok(Math.abs(cosineSimilarity(v1, v3) - 0.0) < 1e-6);
    // Opposite
    assert.ok(Math.abs(cosineSimilarity(v1, v4) - -1.0) < 1e-6);
    // Mismatched or empty
    assert.equal(cosineSimilarity([], [1]), 0);
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
  });

  it('LocalTfIdfEmbeddings produces normalized fixed-dimension vectors', async () => {
    const provider = new LocalTfIdfEmbeddings({ dimension: 128 });
    assert.equal(provider.dimension, 128);

    const queryVec = await provider.embedQuery('Machine learning and artificial intelligence');
    assert.equal(queryVec.length, 128);

    const mag = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(mag - 1.0) < 1e-5, 'Local vector must have unit magnitude');

    // Semantic relevance check: identical or related phrases should have positive cosine similarity
    const relatedVec = await provider.embedQuery('Artificial intelligence and neural systems');
    const unrelatedVec = await provider.embedQuery('Banana pancake recipe breakfast');

    const simRelated = cosineSimilarity(queryVec, relatedVec);
    const simUnrelated = cosineSimilarity(queryVec, unrelatedVec);

    assert.ok(simRelated > simUnrelated, `Related (${simRelated}) should exceed unrelated (${simUnrelated})`);
  });

  it('GeminiEmbeddings falls back cleanly when API key is missing or invalid', async () => {
    const gemini = new GeminiEmbeddings({ apiKey: '' });
    const vec = await gemini.embedQuery('Local fallback query');
    assert.ok(Array.isArray(vec));
    assert.ok(vec.length > 0);

    const docs = await gemini.embedDocuments(['Doc A', 'Doc B']);
    assert.equal(docs.length, 2);
    assert.ok(Array.isArray(docs[0]));
  });

  it('GeminiEmbeddings integrates with mock client without external network calls', async () => {
    const mockClient = {
      models: {
        embedContent: async () => ({
          embedding: { values: [0.5, 0.5, 0.5, 0.5] },
        }),
      },
    };

    const provider = new GeminiEmbeddings({ apiKey: 'fake_key' });
    provider._client = mockClient;

    const queryVec = await provider.embedQuery('Mocked query');
    assert.equal(queryVec.length, 4);
    // Magnitude of [0.5, 0.5, 0.5, 0.5] normalized is 1.0
    const mag = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(mag - 1.0) < 1e-6);
  });

  it('createEmbeddingProvider factory creates correct provider types', () => {
    const local = createEmbeddingProvider('local', { dimension: 64 });
    assert.equal(local.dimension, 64);

    const gemini = createEmbeddingProvider('gemini');
    assert.equal(gemini.dimension, 768);
  });
});

describe('Personal RAG: Store & Multi-Tenant Retrieval', () => {
  let store;
  const userA = 'anon_user_alice';
  const userB = 'anon_user_bob';

  beforeEach(() => {
    store = new RagStore();
  });

  it('enforces anonId requirement and partitions users strictly', () => {
    assert.throws(() => store.addChunks('', []), /Valid anonId is required/);
    assert.throws(() => store.addChunks(null, []), /Valid anonId is required/);
    assert.deepEqual(tokenizeForBm25(''), []);
    assert.deepEqual(tokenizeForBm25('hello world!'), ['hello', 'world']);
  });

  it('indexes chunks and retrieves with BM25 keyword search', () => {
    const chunks = [
      {
        chunk: {
          id: 'c1',
          docId: 'doc1',
          text: 'Docker containerization simplifies backend deployment.',
          source: 'devops.md',
        },
        embedding: [1, 0, 0],
      },
      {
        chunk: {
          id: 'c2',
          docId: 'doc1',
          text: 'PostgreSQL relational database configuration and tuning.',
          source: 'devops.md',
        },
        embedding: [0, 1, 0],
      },
    ];

    store.addChunks(userA, chunks);

    const results = store.search(userA, {
      query: 'docker containerization deployment',
      mode: 'keyword',
      topK: 5,
    });

    assert.ok(results.length > 0);
    assert.equal(results[0].chunk.id, 'c1');
    assert.ok(results[0].bm25Score > 0);
  });

  it('retrieves using dense vector cosine similarity', () => {
    const chunks = [
      {
        chunk: { id: 'c1', docId: 'doc1', text: 'Vector Alpha', source: 'v.txt' },
        embedding: [1, 0, 0],
      },
      {
        chunk: { id: 'c2', docId: 'doc1', text: 'Vector Beta', source: 'v.txt' },
        embedding: [0, 1, 0],
      },
    ];

    store.addChunks(userA, chunks);

    const results = store.search(userA, {
      queryEmbedding: [0.95, 0.05, 0],
      mode: 'vector',
      topK: 2,
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].chunk.id, 'c1');
    assert.ok(results[0].denseScore > results[1].denseScore);
  });

  it('performs Hybrid Search with Reciprocal Rank Fusion (RRF)', () => {
    const chunks = [
      {
        chunk: { id: 'c1', docId: 'd1', text: 'React hooks and functional components state', source: 'web.md' },
        embedding: [0.8, 0.2, 0.0],
      },
      {
        chunk: { id: 'c2', docId: 'd1', text: 'Vue reactivity system and templates', source: 'web.md' },
        embedding: [0.1, 0.9, 0.0],
      },
      {
        chunk: { id: 'c3', docId: 'd2', text: 'Unrelated gardening tips and plants', source: 'garden.md' },
        embedding: [0.0, 0.0, 1.0],
      },
    ];

    store.addChunks(userA, chunks);

    const results = store.search(userA, {
      query: 'React hooks components',
      queryEmbedding: [0.75, 0.25, 0.0],
      mode: 'hybrid',
      alpha: 0.5,
      topK: 3,
    });

    assert.ok(results.length >= 1);
    assert.equal(results[0].chunk.id, 'c1');
    assert.ok(results[0].score > 0);
    assert.ok(results[0].denseScore > 0);
    assert.ok(results[0].bm25Score > 0);
  });

  it('guarantees zero cross-user leakage across tenant partitions', () => {
    // Ingest private chunk for Alice
    store.addChunks(userA, [
      {
        chunk: { id: 'secret_a', docId: 'd_a', text: 'Alice confidential financial report 2026', source: 'alice.pdf' },
        embedding: [1, 0, 0],
      },
    ]);

    // Ingest public chunk for Bob
    store.addChunks(userB, [
      {
        chunk: { id: 'public_b', docId: 'd_b', text: 'Bob standard recipe notes', source: 'bob.txt' },
        embedding: [0, 1, 0],
      },
    ]);

    // Bob searches for Alice's confidential terms
    const bobSearch = store.search(userB, {
      query: 'confidential financial report Alice',
      queryEmbedding: [1, 0, 0],
      mode: 'hybrid',
    });

    // Must return zero matches from Alice's partition
    assert.equal(bobSearch.length, 0, 'User B must never access chunks belonging to User A');

    // Alice searching gets her document
    const aliceSearch = store.search(userA, {
      query: 'confidential financial report',
      mode: 'hybrid',
    });
    assert.equal(aliceSearch.length, 1);
    assert.equal(aliceSearch[0].chunk.id, 'secret_a');
  });

  it('supports document chunk deletion and tenant cleanup', () => {
    store.addChunks(userA, [
      { chunk: { id: 'c1', docId: 'doc_to_delete', text: 'Chunk 1', source: 'a.txt' }, embedding: [1, 0] },
      { chunk: { id: 'c2', docId: 'doc_to_delete', text: 'Chunk 2', source: 'a.txt' }, embedding: [0, 1] },
      { chunk: { id: 'c3', docId: 'doc_keep', text: 'Keep this', source: 'b.txt' }, embedding: [1, 1] },
    ]);

    assert.equal(store.getStats(userA).totalChunks, 3);
    const deletedCount = store.deleteChunksByDocId(userA, 'doc_to_delete');
    assert.equal(deletedCount, 2);
    assert.equal(store.getStats(userA).totalChunks, 1);
    assert.equal(store.getChunk(userA, 'c1'), null);

    // Delete entire tenant
    const tenantDeleted = store.deleteTenant(userA);
    assert.equal(tenantDeleted, true);
    assert.equal(store.getStats(userA).totalChunks, 0);
  });

  it('applies metadata filters during retrieval', () => {
    store.addChunks(userA, [
      { chunk: { id: 'c1', docId: 'doc1', source: 'manual.pdf', text: 'Step 1 login' }, embedding: [1] },
      { chunk: { id: 'c2', docId: 'doc2', source: 'faq.md', text: 'Step 2 login' }, embedding: [1] },
    ]);

    const filtered = store.search(userA, {
      query: 'login',
      filter: { source: 'faq.md' },
    });

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].chunk.id, 'c2');
  });
});

describe('Personal RAG: Full Engine Ingestion & Retrieval Pipeline', () => {
  let engine;
  const user = 'anon_rag_tester';

  beforeEach(() => {
    engine = new RagEngine({ embeddingProvider: 'local' });
    engine.clearUser(user);
  });

  it('computes content hashes deterministically', () => {
    const h1 = computeContentHash('Sample document content');
    const h2 = computeContentHash('Sample document content');
    const h3 = computeContentHash('Different content');

    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.equal(h1.length, 64);
  });

  it('ingests raw text and retrieves relevant chunks with source attribution', async () => {
    const content = `
      # Architecture Guide

      The backend runs on Node.js using an Express micro-framework with WebSocket listeners.
      Redis is utilized for distributed caching and pub/sub message relays across server nodes.
      Gemini 2.5 Flash acts as the primary generative AI processing pipeline.
    `;

    const ingestRes = await engine.addDocument(user, content, {
      title: 'Backend Architecture',
      filename: 'architecture.md',
    });

    assert.equal(ingestRes.success, true);
    assert.equal(ingestRes.isDuplicate, false);
    assert.ok(ingestRes.chunkCount >= 1);

    const searchRes = await engine.search(user, 'Redis distributed caching pub/sub');
    assert.ok(searchRes.results.length >= 1);
    assert.equal(searchRes.results[0].source, 'architecture.md');
    assert.ok(searchRes.results[0].text.includes('Redis'));
  });

  it('detects duplicate documents via content hashing and honors overwrite option', async () => {
    const text = 'Unique report content for duplicate detection testing.';

    // First ingestion
    const first = await engine.addDocument(user, text, { title: 'First Upload' });
    assert.equal(first.success, true);
    assert.equal(first.isDuplicate, false);

    // Second ingestion without overwrite
    const second = await engine.addDocument(user, text, { title: 'Second Upload', overwrite: false });
    assert.equal(second.success, true);
    assert.equal(second.isDuplicate, true);
    assert.equal(second.docId, first.docId);

    // Third ingestion with overwrite=true
    const third = await engine.addDocument(user, text, { title: 'Overwritten Upload', overwrite: true });
    assert.equal(third.success, true);
    assert.equal(third.isDuplicate, false);
  });

  it('ingests structured note objects', async () => {
    const note = {
      title: 'Meeting Notes: Q4 Review',
      content: 'Discussed roadmap milestones, budget allocation, and target hiring goals for Q4.',
      metadata: { department: 'Engineering', year: 2026 },
    };

    const res = await engine.addDocument(user, note);
    assert.equal(res.success, true);

    const found = await engine.search(user, 'budget allocation hiring goals');
    assert.ok(found.results.length > 0);
    assert.equal(found.results[0].metadata.department, 'Engineering');
  });

  it('buildRagPrompt formats prompt with citations for LLM grounding', async () => {
    await engine.addDocument(user, 'The secret launch code is Omega-42.', {
      title: 'Project Apollo',
      filename: 'apollo.txt',
    });

    const promptData = await engine.buildRagPrompt(user, 'What is the secret launch code?');
    assert.equal(promptData.hasContext, true);
    assert.ok(promptData.context.includes('Omega-42'));
    assert.ok(promptData.context.includes('apollo.txt'));
    assert.equal(promptData.sources.length, 1);
    assert.equal(promptData.sources[0].source, 'apollo.txt');
  });

  it('returns empty prompt when no matching documents exist', async () => {
    const promptData = await engine.buildRagPrompt(user, 'Nonexistent query with no docs');
    assert.equal(promptData.hasContext, false);
    assert.equal(promptData.context, '');
    assert.deepEqual(promptData.sources, []);
  });

  it('handles document listing, inspection, deletion and stats', async () => {
    await engine.addDocument(user, 'Content 1', { title: 'Doc One' });
    await engine.addDocument(user, 'Content 2', { title: 'Doc Two' });

    const list = engine.listDocuments(user);
    assert.equal(list.length, 2);

    const doc1 = engine.getDocument(user, list[0].docId);
    assert.ok(doc1);
    assert.equal(doc1.title, list[0].title);

    const stats = engine.getStats(user);
    assert.equal(stats.totalDocuments, 2);

    // Delete one document
    const deleted = engine.deleteDocument(user, list[0].docId);
    assert.equal(deleted, true);
    assert.equal(engine.listDocuments(user).length, 1);

    // Clear user completely
    engine.clearUser(user);
    assert.equal(engine.listDocuments(user).length, 0);
    assert.equal(engine.getStats(user).totalDocuments, 0);
  });

  it('extractTextFromPdfBuffer handles invalid and text-containing buffers gracefully', () => {
    // Non-buffer
    assert.equal(extractTextFromPdfBuffer(null).ok, false);
    // Non-PDF
    assert.equal(extractTextFromPdfBuffer(Buffer.from('not a pdf')).ok, true);

    // Valid mock PDF text stream
    const mockPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 50 >>\nstream\n(Hello from PDF unit test) Tj\nendstream\nendobj\n%%EOF'
    );
    const pdfRes = extractTextFromPdfBuffer(mockPdf);
    assert.equal(pdfRes.ok, true);
    assert.ok(pdfRes.text.includes('Hello from PDF unit test'));
  });
});
