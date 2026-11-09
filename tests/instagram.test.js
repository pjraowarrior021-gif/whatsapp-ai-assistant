import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isInstagramUrl,
  extractInstagramShortcode,
  parseInstagramMetadata,
  fetchInstagramPostData,
  buildInstagramAiPrompt,
} from '../src/instagram.js';

test('Instagram: isInstagramUrl correctly detects valid Instagram Reel, Post, TV and Share URLs', () => {
  const valid = [
    'https://www.instagram.com/reel/DKn-PT1PMnr/?igsh=MXI4aWUwY29kcWRzMw==',
    'https://instagram.com/reel/DKn-PT1PMnr/',
    'https://www.instagram.com/p/C-xyz123/',
    'https://www.instagram.com/reels/DKn-PT1PMnr/',
    'https://www.instagram.com/tv/B_xyz123/',
    'https://www.instagram.com/share/reel/DKn-PT1PMnr/',
    'https://instagr.am/p/C-xyz123/',
    'Check out this food reel: https://www.instagram.com/reel/DKn-PT1PMnr/ please!',
  ];

  for (const url of valid) {
    assert.strictEqual(isInstagramUrl(url), true, `Failed to validate: ${url}`);
  }
});

test('Instagram: isInstagramUrl rejects non-Instagram links and spoofed hostnames', () => {
  const invalid = [
    'https://instagram.com.evil.com/reel/DKn-PT1PMnr/',
    'https://fakeinstagram.com/p/12345',
    'https://example.com/reel/12345',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'Not a url at all',
    '',
    null,
  ];

  for (const url of invalid) {
    assert.strictEqual(isInstagramUrl(url), false, `Should reject: ${url}`);
  }
});

test('Instagram: extractInstagramShortcode extracts correct shortcodes from various formats', () => {
  assert.strictEqual(
    extractInstagramShortcode('https://www.instagram.com/reel/DKn-PT1PMnr/?igsh=MXI4aWUwY29kcWRzMw=='),
    'DKn-PT1PMnr'
  );
  assert.strictEqual(extractInstagramShortcode('https://instagram.com/p/C9abcXYZ/'), 'C9abcXYZ');
  assert.strictEqual(extractInstagramShortcode('https://www.instagram.com/share/reel/DKn-PT1PMnr/'), 'DKn-PT1PMnr');
  assert.strictEqual(extractInstagramShortcode('https://example.com/p/12345'), null);
});

test('Instagram: parseInstagramMetadata extracts author handle and clean caption text', () => {
  const ogTitle = 'Shreya on Instagram: "New place alert 🎉 @garci.blr , launched in namma Bengaluru."';
  const ogDesc = 'New place alert 🎉 @garci.blr , launched in namma Bengaluru. - @what_i_love_shreya on June 7, 2025';

  const { author, caption } = parseInstagramMetadata(ogTitle, ogDesc);
  assert.strictEqual(author, 'Shreya');
  assert.ok(caption.includes('@garci.blr'));
  assert.ok(caption.includes('namma Bengaluru'));
  assert.ok(!caption.includes('- @what_i_love_shreya on June 7, 2025'));
});

test('Instagram: fetchInstagramPostData parses mocked Open Graph metadata safely', async () => {
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Shreya on Instagram</title>
        <meta property="og:title" content="Shreya on Instagram: &quot;New place alert &#x1f389; &#064;garci.blr&quot;">
        <meta property="og:description" content="New place alert &#x1f389; &#064;garci.blr , launched in Bengaluru. Best vegetarian food! - &#064;what_i_love_shreya on June 7, 2025">
      </head>
      <body><div>Instagram Web</div></body>
    </html>
  `;

  const result = await fetchInstagramPostData('https://www.instagram.com/reel/DKn-PT1PMnr/', { mockHtml });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shortcode, 'DKn-PT1PMnr');
  assert.strictEqual(result.isReel, true);
  assert.strictEqual(result.author, 'Shreya');
  assert.ok(result.caption.includes('@garci.blr'));
  assert.ok(result.caption.includes('🎉'));
});

test('Instagram: fetchInstagramPostData falls back gracefully on network or HTTP error', async () => {
  const mockFetcher = async () => ({
    ok: false,
    status: 403,
  });

  const result = await fetchInstagramPostData('https://www.instagram.com/reel/DKn-PT1PMnr/', {
    fetcher: mockFetcher,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shortcode, 'DKn-PT1PMnr');
  assert.strictEqual(result.reason, 'http_403');
  assert.strictEqual(result.title, 'Instagram Reel');
});

test('Instagram: buildInstagramAiPrompt constructs structured WhatsApp prompt', () => {
  const instaData = {
    url: 'https://www.instagram.com/reel/DKn-PT1PMnr/',
    title: 'Shreya on Instagram',
    author: 'Shreya',
    caption: 'New place alert @garci.blr in Bengaluru! Amazing Kunafa cream cheese and sushi.',
    isReel: true,
  };

  const prompt = buildInstagramAiPrompt(instaData, 'Where is this place located?');
  assert.ok(prompt.includes('The user shared this Instagram Reel'));
  assert.ok(prompt.includes('User Question/Instruction: "Where is this place located?"'));
  assert.ok(prompt.includes('@garci.blr in Bengaluru'));
  assert.ok(prompt.includes('Venue / Main Subject'));
  assert.ok(prompt.includes('Highlights & Key Details'));
});
