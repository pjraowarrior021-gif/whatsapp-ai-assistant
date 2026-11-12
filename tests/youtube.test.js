import test from 'node:test';
import assert from 'node:assert';
import {
  extractYouTubeVideoId,
  isYouTubeUrl,
  isYouTubeDomain,
  formatVideoTimestamp,
  formatTranscript,
  fetchYouTubeVideoData,
  buildYouTubeAiPrompt,
} from '../src/youtube.js';

test('YouTube: extractYouTubeVideoId parses all standard and short URL formats', () => {
  const cases = [
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ&t=120s', expected: 'dQw4w9WgXcQ' },
    { url: 'https://youtu.be/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://youtu.be/dQw4w9WgXcQ?si=abcdef12345', expected: 'dQw4w9WgXcQ' },
    { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://m.youtube.com/watch?v=dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://www.youtube.com/live/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
    { url: 'Can you summarize https://youtu.be/dQw4w9WgXcQ please?', expected: 'dQw4w9WgXcQ' },
  ];

  for (const c of cases) {
    const id = extractYouTubeVideoId(c.url);
    assert.strictEqual(id, c.expected, `Failed for input: ${c.url}`);
    assert.strictEqual(isYouTubeUrl(c.url), true);
  }
});

test('YouTube: extractYouTubeVideoId rejects non-YouTube links and invalid inputs', () => {
  const invalid = [
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/123456789',
    'just plain text without links',
    '',
    null,
    undefined,
  ];

  for (const item of invalid) {
    assert.strictEqual(extractYouTubeVideoId(item), null);
    assert.strictEqual(isYouTubeUrl(item), false);
  }
});

test('YouTube: isYouTubeDomain identifies YouTube hosts even when link is truncated or video ID is invalid', () => {
  // Truncated or incomplete links (like the user report)
  assert.strictEqual(isYouTubeDomain('https://www.youtube.com/shorts/4Mer-_'), true);
  assert.strictEqual(isYouTubeDomain('https://youtu.be/short'), true);
  assert.strictEqual(isYouTubeDomain('https://m.youtube.com/watch'), true);
  assert.strictEqual(isYouTubeDomain('https://music.youtube.com/playlist?list=123'), true);

  // Complete valid links
  assert.strictEqual(isYouTubeDomain('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);

  // Non-YouTube links
  assert.strictEqual(isYouTubeDomain('https://example.com/shorts/4Mer-_'), false);
  assert.strictEqual(isYouTubeDomain('https://instagram.com/reel/123'), false);
  assert.strictEqual(isYouTubeDomain(null), false);
  assert.strictEqual(isYouTubeDomain(''), false);
});

test('YouTube: formatVideoTimestamp formats seconds into MM:SS and HH:MM:SS', () => {
  assert.strictEqual(formatVideoTimestamp(0), '00:00');
  assert.strictEqual(formatVideoTimestamp(45), '00:45');
  assert.strictEqual(formatVideoTimestamp(65), '01:05');
  assert.strictEqual(formatVideoTimestamp(3600), '01:00:00');
  assert.strictEqual(formatVideoTimestamp(3665), '01:01:05');
});

test('YouTube: formatTranscript groups and formats items with timestamps', () => {
  const mockItems = [
    { text: 'Welcome to this tutorial on AI.', offset: 0, duration: 2000 },
    { text: 'Today we will cover deep learning.', offset: 3000, duration: 3000 },
    { text: '[Music]', offset: 10000, duration: 2000 },
    { text: 'First, let us define neural networks.', offset: 75000, duration: 4000 },
    { text: 'They consist of input, hidden, and output layers.', offset: 80000, duration: 4000 },
  ];

  const formatted = formatTranscript(mockItems);
  assert.ok(formatted.includes('[00:00] Welcome to this tutorial on AI. Today we will cover deep learning.'));
  assert.ok(!formatted.includes('[Music]'));
  assert.ok(
    formatted.includes(
      '[01:15] First, let us define neural networks. They consist of input, hidden, and output layers.'
    )
  );
});

test('YouTube: fetchYouTubeVideoData succeeds with mocked transcript fetcher', async () => {
  const mockFetcher = async (id) => {
    assert.strictEqual(id, 'test_vid_123');
    return [
      { text: 'Hello and welcome.', offset: 0, duration: 2000 },
      { text: 'This is a test transcript.', offset: 4000, duration: 3000 },
    ];
  };

  const res = await fetchYouTubeVideoData('test_vid_123', { fetcher: mockFetcher });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.hasTranscript, true);
  assert.ok(res.transcriptText.includes('Hello and welcome. This is a test transcript.'));
  assert.strictEqual(res.url, 'https://www.youtube.com/watch?v=test_vid_123');
});

test('YouTube: fetchYouTubeVideoData handles disabled transcripts gracefully', async () => {
  const mockFetcher = async () => {
    throw new Error('Transcript is disabled for this video');
  };

  const res = await fetchYouTubeVideoData('test_disabled', { fetcher: mockFetcher });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.hasTranscript, false);
  assert.strictEqual(res.reason, 'transcripts_disabled');
});

test('YouTube: fetchYouTubeVideoData falls back gracefully when IP is rate limited (429)', async () => {
  const mockFetcher = async () => {
    throw new Error('Too Many Requests (429)');
  };

  const res = await fetchYouTubeVideoData('test_429', { fetcher: mockFetcher });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.hasTranscript, false);
  assert.strictEqual(res.reason, 'fetch_error_fallback');
  assert.ok(res.error.includes('429'));
});

test('YouTube: buildYouTubeAiPrompt builds prompt with transcript and timestamps', () => {
  const videoData = {
    title: 'Intro to Quantum Computing',
    author: 'Tech Academy',
    url: 'https://www.youtube.com/watch?v=abc123xyz89',
    hasTranscript: true,
    transcriptText: '[00:00] Welcome to quantum computing.\n\n[01:30] Qubits and superposition explained.',
  };

  const prompt = buildYouTubeAiPrompt(videoData, 'Explain qubits simply');
  assert.ok(prompt.includes('Intro to Quantum Computing'));
  assert.ok(prompt.includes('Tech Academy'));
  assert.ok(prompt.includes('User Question/Instruction: "Explain qubits simply"'));
  assert.ok(prompt.includes('[01:30] Qubits and superposition explained.'));
  assert.ok(prompt.includes('Core Thesis / Overview'));
  assert.ok(prompt.includes('Key Topic Timestamps'));
});

test('YouTube: buildYouTubeAiPrompt builds fallback prompt when transcript is disabled', () => {
  const videoData = {
    title: 'Music Concert Live 2026',
    author: 'Rock Band',
    url: 'https://www.youtube.com/watch?v=concert1234',
    hasTranscript: false,
  };

  const prompt = buildYouTubeAiPrompt(videoData);
  assert.ok(prompt.includes('Music Concert Live 2026'));
  assert.ok(prompt.includes('Rock Band'));
  assert.ok(prompt.includes('Public captions and subtitles are disabled'));
});
