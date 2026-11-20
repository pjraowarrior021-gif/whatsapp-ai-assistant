import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUrl,
  extractUserPromptAside,
  isSafeUrl,
  cleanHtml,
  fetchAndExtractArticle,
} from '../src/web-scraper.js';

test('WebScraper: extractUrl identifies standard http and https URLs', () => {
  assert.strictEqual(
    extractUrl('Check out this article: https://example.com/news/123 for details'),
    'https://example.com/news/123'
  );
  assert.strictEqual(extractUrl('http://test.org/path?q=query#hash'), 'http://test.org/path?q=query#hash');
  assert.strictEqual(extractUrl('No links here! Just conversation.'), null);
  assert.strictEqual(extractUrl(''), null);
  assert.strictEqual(extractUrl(null), null);
});

test('WebScraper: extractUserPromptAside isolates user prompt from links and preview metadata', () => {
  const forwardedMessage = [
    'www.youtube.com',
    'https://www.youtube.com/shorts/4Mer-_',
    'www.youtube.com',
    '',
    'https://www.youtube.com/shorts/4Mer-_',
    'Help me identify the individual songs in this mix from a few lyrics and clues from the video.',
  ].join('\n');

  const result = extractUserPromptAside(forwardedMessage, 'https://www.youtube.com/shorts/4Mer-_');
  assert.strictEqual(
    result,
    'Help me identify the individual songs in this mix from a few lyrics and clues from the video.'
  );

  // Link only returns empty string
  assert.strictEqual(extractUserPromptAside('https://example.com/page', 'https://example.com/page'), '');

  // Text with inline link
  assert.strictEqual(
    extractUserPromptAside('Check this out: https://example.com/doc Can you summarize?', 'https://example.com/doc'),
    'Check this out:  Can you summarize?'
  );

  // Null/undefined safety
  assert.strictEqual(extractUserPromptAside(null), '');
  assert.strictEqual(extractUserPromptAside(''), '');
});

test('WebScraper: isSafeUrl blocks private, loopback, link-local and cloud metadata addresses (SSRF guard)', () => {
  // Loopback and local
  assert.strictEqual(isSafeUrl('http://127.0.0.1:8080/admin'), false);
  assert.strictEqual(isSafeUrl('http://localhost:3000/api'), false);
  assert.strictEqual(isSafeUrl('http://[::1]/secret'), false);

  // Private RFC1918 subnets
  assert.strictEqual(isSafeUrl('http://10.0.0.5/internal'), false);
  assert.strictEqual(isSafeUrl('http://192.168.1.1/router'), false);
  assert.strictEqual(isSafeUrl('http://172.16.0.1/status'), false);
  assert.strictEqual(isSafeUrl('http://172.31.255.255/intranet'), false);

  // Cloud metadata endpoint
  assert.strictEqual(isSafeUrl('http://169.254.169.254/latest/meta-data/'), false);

  // Unsupported protocols
  assert.strictEqual(isSafeUrl('ftp://ftp.example.com/file'), false);
  assert.strictEqual(isSafeUrl('file:///etc/passwd'), false);

  // Valid public domains
  assert.strictEqual(isSafeUrl('https://en.wikipedia.org/wiki/Artificial_intelligence'), true);
  assert.strictEqual(isSafeUrl('https://news.ycombinator.com/'), true);
});

test('WebScraper: cleanHtml removes boilerplates, scripts, styles, and decodes HTML entities', () => {
  const rawHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Sample Article &amp; Insights</title>
        <style>body { color: red; }</style>
        <script>alert("hack");</script>
      </head>
      <body>
        <nav><a href="/">Home</a> <a href="/about">About</a></nav>
        <main>
          <h1>Deep Learning Overview</h1>
          <p>Neural networks process information in &quot;layers&quot; &lt;input and output&gt;.</p>
        </main>
        <footer>&copy; 2026 Company Inc. All rights reserved.</footer>
      </body>
    </html>
  `;

  const cleaned = cleanHtml(rawHtml);
  assert.strictEqual(cleaned.title, 'Sample Article & Insights');
  assert.ok(cleaned.text.includes('Deep Learning Overview'));
  assert.ok(cleaned.text.includes('Neural networks process information in "layers" <input and output>.'));
  assert.ok(!cleaned.text.includes('alert("hack")'));
  assert.ok(!cleaned.text.includes('body { color: red; }'));
  assert.ok(!cleaned.text.includes('All rights reserved'));
});

test('WebScraper: fetchAndExtractArticle blocks SSRF before making any HTTP request', async () => {
  const result = await fetchAndExtractArticle('http://127.0.0.1:8080/config');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ssrf_blocked');
});

test('WebScraper: fetchAndExtractArticle safely parses article with mocked network response', async () => {
  const originalFetch = globalThis.fetch;
  const mockHtml = `
    <html>
      <head><title>Space Exploration Update</title></head>
      <body>
        <h1>Mission to Mars</h1>
        <p>The Perseverance rover has officially discovered unambiguous signs of ancient riverbeds and geological sediment layers in the Jezero crater on Mars.</p>
      </body>
    </html>
  `;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null),
    },
    text: async () => mockHtml,
  });

  try {
    const result = await fetchAndExtractArticle('https://example.com/mars-mission');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.title, 'Space Exploration Update');
    assert.ok(result.text.includes('Mission to Mars'));
    assert.ok(result.text.includes('ancient riverbeds'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebScraper: cleanHtml falls back to Open Graph description when body text is empty/short', () => {
  const spaHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>SPA Dashboard</title>
        <meta property="og:title" content="Viral Video Title - Creator &amp; Venue">
        <meta property="og:description" content="This is an extensive description of the video with venue @spot and top culinary dishes &amp; tips.">
      </head>
      <body>
        <div id="root"></div>
      </body>
    </html>
  `;

  const cleaned = cleanHtml(spaHtml);
  assert.strictEqual(cleaned.title, 'Viral Video Title - Creator & Venue');
  assert.ok(cleaned.text.includes('This is an extensive description of the video'));
  assert.ok(cleaned.text.includes('venue @spot'));
});

test('WebScraper: fetchAndExtractArticle succeeds on JS SPA shell by extracting Open Graph meta description', async () => {
  const originalFetch = globalThis.fetch;
  const mockSpaHtml = `
    <html>
      <head>
        <title>App Preview</title>
        <meta property="og:description" content="Detailed overview of a new restaurant in Bengaluru with food recommendations and opening hours.">
      </head>
      <body><div id="app"></div></body>
    </html>
  `;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null),
    },
    text: async () => mockSpaHtml,
  });

  try {
    const result = await fetchAndExtractArticle('https://example.com/spa-post');
    assert.strictEqual(result.ok, true);
    assert.ok(result.text.includes('Detailed overview of a new restaurant in Bengaluru'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
