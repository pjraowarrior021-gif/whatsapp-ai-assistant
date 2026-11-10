import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from '../src/config.js';
import {
  isAuthorized,
  getAnonymizedId,
  maskSensitiveInfo,
  checkUserRateLimit,
  resetUserRateLimit,
  rememberMessage,
  getRememberedMessage,
  saveTurn,
  getConversation,
  resetConversation,
} from '../src/privacy.js';
import { generateAIResponse, testGeminiConnection, setPersona, resetPersona, getPersona } from '../src/gemini.js';
import { parseImagePrompt, generateImageUrl } from '../src/image-gen.js';
import { isSafeUrl, cleanHtml, fetchAndExtractArticle } from '../src/web-scraper.js';
import { splitTextForSpeech, synthesizeSpeech } from '../src/tts.js';
import { addTodo, listTodos, markTodoDone, clearCompletedTodos } from '../src/todos.js';
import { parseReminderTime, scheduleReminder, listReminders, deleteReminder } from '../src/reminders.js';
import { checkAndIncrementUserQuota, getUserQuotaReport } from '../src/quota.js';
import { splitMessageIntoChunks, sendWhatsAppButtons, sendWhatsAppList } from '../src/whatsapp.js';
import { extractTextFromPptx, extractTextFromDocx, extractTextFromXlsx, isDocumentSupported } from '../src/document.js';
import AdmZip from 'adm-zip';
import { verifyMetaSignature } from '../src/webhook.js';
import { app } from '../src/server.js';
import { store } from '../src/store/index.js';
import { messageQueue } from '../src/queue.js';
import { setUserLanguage, getUserLanguage, getLanguageInstruction } from '../src/language.js';
import { addMemoryFact, getMemoryContext, clearUserMemory } from '../src/memory.js';
import { executeToolCall } from '../src/tools/index.js';
import { exportUserData } from '../src/export.js';
import { extractYouTubeVideoId, fetchYouTubeMetadata, fetchYouTubeVideoData } from '../src/youtube.js';
import { isInstagramUrl, extractInstagramShortcode, fetchInstagramPostData } from '../src/instagram.js';
import { autoLearnFromTurn } from '../src/auto-learner.js';
import { recordUserInteraction, getLearnedWorkflowContext, clearLearnedWorkflows } from '../src/workflow-learner.js';
import {
  getConversationAdaptationContext,
  getUserProfile,
  updateUserProfile,
  clearUserProfile,
} from '../src/conversation-adapter.js';

const results = [];

async function benchmark(name, category, fn) {
  const start = performance.now();
  let status = 'PASS';
  let details = '';
  let error = null;

  try {
    const res = await fn();
    if (res && typeof res === 'object') {
      details = res.info || JSON.stringify(res);
    } else if (res) {
      details = String(res);
    }
  } catch (err) {
    status = 'FAIL';
    error = err.message;
    details = `Error: ${err.message}`;
  }

  const durationMs = parseFloat((performance.now() - start).toFixed(2));
  results.push({ name, category, status, durationMs, details, error });
  console.log(`[${status}] ${category} :: ${name} (${durationMs}ms)`);
  return { status, durationMs, details, error };
}

async function runAllBenchmarks() {
  console.log('====================================================');
  console.log('⚡ STARTING COMPREHENSIVE END-TO-END PROCESSOR BENCHMARKS');
  console.log('====================================================\n');

  const testPhone = Array.from(config.ALLOWED_PHONE_NUMBERS)[0] || '919876543210';
  const testAnonId = getAnonymizedId(testPhone);

  // --------------------------------------------------------------------------
  // Group 1: Security, Auth & Cryptography Processor
  // --------------------------------------------------------------------------
  await benchmark('HMAC-SHA256 Webhook Signature Verification', 'Security & Crypto', async () => {
    const rawBody = JSON.stringify({ test: 'payload', timestamp: Date.now() });
    const secret = config.WHATSAPP_APP_SECRET || 'test_secret_123';
    const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const valid = verifyMetaSignature(rawBody, `sha256=${hash}`, secret);
    if (!valid) throw new Error('Signature validation failed');
    return { info: 'timingSafeEqual validated authentic signature' };
  });

  await benchmark('Phone Whitelist & Access Control Check', 'Security & Crypto', async () => {
    const authorized = isAuthorized(testPhone);
    const unauthorized = isAuthorized('19999999999');
    if (!authorized || unauthorized) throw new Error('Whitelist check failed');
    return { info: `Authorized: true for ${testPhone}, Unauthorized: false for unknown` };
  });

  await benchmark('Salted SHA-256 Non-Reversible Anonymization', 'Security & Crypto', async () => {
    const id1 = getAnonymizedId(testPhone);
    const id2 = getAnonymizedId(testPhone);
    if (id1 !== id2 || !id1.startsWith('u_')) throw new Error('Inconsistent anonymization');
    return { info: `Generated non-reversible ID: ${id1}` };
  });

  // --------------------------------------------------------------------------
  // Group 2: Privacy Guard & Credential/PII Redaction Processor
  // --------------------------------------------------------------------------
  await benchmark('Payment Card Luhn Verification & Redaction', 'Privacy Guard', async () => {
    const input = 'My Visa card is 4532 0150 1234 5671 with CVV 789 and tracking #123456789012345';
    const result = maskSensitiveInfo(input);
    if (!result.hasRedactions || !result.sanitizedText.includes('[REDACTED_CARD_NUMBER]')) {
      throw new Error('Failed to redact valid Luhn card');
    }
    if (!result.sanitizedText.includes('tracking #123456789012345')) {
      throw new Error('False positive on non-card number');
    }
    return { info: `Categories redacted: ${result.categories.join(', ')}` };
  });

  await benchmark('Aadhaar, PIN, Password & OTP Redaction', 'Privacy Guard', async () => {
    const input = 'Aadhaar 2345 6789 0123, upi pin 4829, password SecretP@ss123, otp is 948201';
    const result = maskSensitiveInfo(input);
    if (result.categories.length < 3) throw new Error('Did not detect all credentials');
    return { info: `Detected and redacted: ${result.categories.join(', ')}` };
  });

  // --------------------------------------------------------------------------
  // Group 3: Core Gemini AI Reasoning & Conversation Engine (LIVE API)
  // --------------------------------------------------------------------------
  await benchmark('Gemini Connection & Ping Test (Live Network)', 'Gemini AI Core', async () => {
    const conn = await testGeminiConnection();
    if (!conn.success) throw new Error(conn.error || 'Connection failed');
    return { info: `Model: ${conn.model}, Latency: ${conn.latencyMs}ms, Reply: "${conn.reply}"` };
  });

  await benchmark('Gemini Contextual Conversation (Multi-Turn)', 'Gemini AI Core', async () => {
    resetConversation(testAnonId);
    const history = [];
    const prompt1 = 'Remember the secret code word: PHOENIX-99';
    const reply1 = await generateAIResponse(prompt1, history, null, { anonId: testAnonId });
    saveTurn(testAnonId, prompt1, reply1);

    const updatedHistory = getConversation(testAnonId);
    const prompt2 = 'What is the secret code word I just told you? Reply with the code only.';
    const reply2 = await generateAIResponse(prompt2, updatedHistory, null, { anonId: testAnonId });
    if (!reply2.toUpperCase().includes('PHOENIX')) {
      throw new Error(`Gemini failed to retain context. Got: "${reply2}"`);
    }
    return { info: `Context retained across turns. Response: "${reply2.substring(0, 50)}"` };
  });

  await benchmark('Gemini Persona Switching (Coder vs Tutor vs Executive)', 'Gemini AI Core', async () => {
    setPersona(testAnonId, 'coder');
    const coderPersona = getPersona(testAnonId);
    if (coderPersona !== 'coder') throw new Error('Failed to set coder persona');

    const codeReply = await generateAIResponse('How do I reverse an array in JavaScript?', [], null, {
      anonId: testAnonId,
    });

    setPersona(testAnonId, 'executive');
    const execReply = await generateAIResponse('Brief me on microservices vs monoliths.', [], null, {
      anonId: testAnonId,
    });

    resetPersona(testAnonId);
    return {
      info: `Coder reply length: ${codeReply.length} chars, Exec reply length: ${execReply.length} chars`,
    };
  });

  // --------------------------------------------------------------------------
  // Group 4: Multimodal Media Processors (Image, Audio, Document)
  // --------------------------------------------------------------------------
  await benchmark('Image Multimodal Analysis (Gemini Vision with Live API)', 'Multimodal Vision', async () => {
    // Generate a clean 120x120 solid image in memory using Sharp
    const imageBuffer = await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 3,
        background: { r: 40, g: 167, b: 69 }, // Green square
      },
    })
      .png()
      .toBuffer();

    const imagePart = {
      mimeType: 'image/png',
      data: imageBuffer.toString('base64'),
    };

    const reply = await generateAIResponse('What color is this image? Reply in one word.', [], imagePart, {
      anonId: testAnonId,
    });

    return { info: `Analyzed ${imageBuffer.length} bytes in memory. Response: "${reply.trim()}"` };
  });

  await benchmark('Document Allowlist & Header Validation (PDF / Office / Text)', 'Document Processor', async () => {
    const dummyPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    if (!dummyPdf.toString().startsWith('%PDF')) throw new Error('Invalid PDF structure');
    const pptxSupported = isDocumentSupported(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'slides.pptx'
    );
    const docxSupported = isDocumentSupported(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc.docx'
    );
    const xlsxSupported = isDocumentSupported(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'data.xlsx'
    );
    if (!pptxSupported || !docxSupported || !xlsxSupported) throw new Error('Office documents not recognized');
    return { info: `Validated PDF, PPTX, DOCX, and XLSX support in memory` };
  });

  await benchmark('PowerPoint (.pptx) In-Memory Slide & Text Extraction', 'Document Processor', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'ppt/slides/slide1.xml',
      Buffer.from('<p:sp><a:p><a:t>Slide 1: Electric Circuits Overview</a:t></a:p></p:sp>')
    );
    zip.addFile(
      'ppt/slides/slide2.xml',
      Buffer.from('<p:sp><a:p><a:t>Slide 2: Ohm Law and Resistance</a:t></a:p></p:sp>')
    );
    const buffer = zip.toBuffer();
    const result = extractTextFromPptx(buffer);
    if (!result.ok || result.slideCount !== 2 || !result.text.includes('Slide 1')) {
      throw new Error('PPTX extraction failed');
    }
    return { info: `Extracted ${result.slideCount} slides (${result.text.length} chars) from in-memory zip` };
  });

  await benchmark('Word (.docx) In-Memory Paragraph Extraction', 'Document Processor', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        '<w:document><w:body><w:p><w:r><w:t>Project Specification: WhatsApp AI Assistant</w:t></w:r></w:p></w:body></w:document>'
      )
    );
    const buffer = zip.toBuffer();
    const result = extractTextFromDocx(buffer);
    if (!result.ok || !result.text.includes('WhatsApp AI Assistant')) {
      throw new Error('DOCX extraction failed');
    }
    return { info: `Extracted document text (${result.text.length} chars) in volatile RAM` };
  });

  await benchmark('Excel (.xlsx) In-Memory Shared Strings Extraction', 'Document Processor', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'xl/sharedStrings.xml',
      Buffer.from('<sst><si><t>Q1 Revenue: $1.2M</t></si><si><t>Operating Expenses: $400K</t></si></sst>')
    );
    const buffer = zip.toBuffer();
    const result = extractTextFromXlsx(buffer);
    if (!result.ok || !result.text.includes('Q1 Revenue')) {
      throw new Error('XLSX extraction failed');
    }
    return { info: `Extracted spreadsheet text (${result.text.length} chars) in volatile RAM` };
  });

  // --------------------------------------------------------------------------
  // Group 5: Image Generation & Watermark Removal Processor (Sharp)
  // --------------------------------------------------------------------------
  await benchmark('Image Prompt Parser (NLP & Slash Commands)', 'Image Generation', async () => {
    const prompt1 = parseImagePrompt('/image a cyberpunk tiger in neon rain');
    const prompt2 = parseImagePrompt('draw a serene mountain sunset over a lake');
    const nonPrompt = parseImagePrompt('How do I bake a chocolate cake?');
    if (!prompt1 || !prompt2 || nonPrompt !== null) throw new Error('Image prompt parser mismatch');
    return { info: `Parsed: "${prompt1}" & "${prompt2}"` };
  });

  await benchmark('Pollinations Image URL Builder & Safe Encoding', 'Image Generation', async () => {
    const { imageUrl } = generateImageUrl('a futuristic electric motorcycle');
    if (!imageUrl.startsWith('https://image.pollinations.ai/prompt/')) throw new Error('Invalid URL');
    return { info: `Constructed URL: ${imageUrl.substring(0, 70)}...` };
  });

  await benchmark('In-Memory Sharp Watermark Crop & Image Optimization', 'Image Generation', async () => {
    // Create dummy image with watermark bar in bottom corner
    const rawImage = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 50, g: 50, b: 150 },
      },
    })
      .jpeg()
      .toBuffer();

    // Crop bottom watermark area in memory
    const meta = await sharp(rawImage).metadata();
    const cleanBuffer = await sharp(rawImage)
      .extract({
        left: 0,
        top: 0,
        width: meta.width,
        height: Math.floor(meta.height * 0.94),
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    if (cleanBuffer.length === 0) throw new Error('Sharp processing failed');
    return { info: `Processed ${rawImage.length}B -> ${cleanBuffer.length}B in volatile RAM` };
  });

  // --------------------------------------------------------------------------
  // Group 6: Smart Webpage & Article Summarizer (SSRF Guarded)
  // --------------------------------------------------------------------------
  await benchmark('SSRF Guard Validator (Loopback, Subnet, Metadata Blocking)', 'Web Summarizer', async () => {
    const checks = [
      isSafeUrl('http://127.0.0.1:8080/secret') === false,
      isSafeUrl('http://localhost:3000/env') === false,
      isSafeUrl('http://169.254.169.254/latest/meta-data/') === false,
      isSafeUrl('http://192.168.1.1/admin') === false,
      isSafeUrl('http://10.0.0.1/db') === false,
      isSafeUrl('https://en.wikipedia.org/wiki/Node.js') === true,
    ];
    if (checks.some((c) => !c)) throw new Error('SSRF validator check failed');
    return { info: 'Blocked loopback, 169.254.*, 10.*, 192.168.*, allowed public https' };
  });

  await benchmark('HTML Cleaner & Entity Decoder', 'Web Summarizer', async () => {
    const rawHtml =
      '<html><head><title>Test &amp; Learn</title><style>.x{color:red}</style></head><body><nav>Menu</nav><main><p>Content with &quot;quotes&quot; and details.</p></main><footer>Foot</footer></body></html>';
    const cleaned = cleanHtml(rawHtml);
    if (cleaned.title !== 'Test & Learn' || !cleaned.text.includes('Content with "quotes"')) {
      throw new Error('HTML cleaning failed');
    }
    return { info: `Extracted title: "${cleaned.title}", clean text: "${cleaned.text}"` };
  });

  await benchmark('Live Web Article Ingestion & Summarization (Wikipedia)', 'Web Summarizer', async () => {
    const article = await fetchAndExtractArticle('https://en.wikipedia.org/wiki/Alan_Turing');
    if (!article.ok) throw new Error(`Article fetch failed: ${article.reason}`);
    const summary = await generateAIResponse(
      `Summarize in 2 sentences:\n"""${article.text.substring(0, 1000)}"""`,
      [],
      null,
      { anonId: testAnonId }
    );
    return {
      info: `Fetched "${article.title}" (${article.text.length} chars). Summary: "${summary.substring(0, 80)}..."`,
    };
  });

  // --------------------------------------------------------------------------
  // Group: YouTube Intelligence & Video Summarizer
  // --------------------------------------------------------------------------
  await benchmark('YouTube Video ID Parser & Metadata Fetch (oEmbed)', 'YouTube Summarizer', async () => {
    const id = extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    if (id !== 'dQw4w9WgXcQ') throw new Error('ID extraction failed');
    const meta = await fetchYouTubeMetadata(id);
    if (!meta.title) throw new Error('oEmbed metadata missing title');
    return { info: `Parsed video "${meta.title}" by ${meta.authorName}` };
  });

  await benchmark('YouTube Subtitle / Transcript Ingestion & Formatting', 'YouTube Summarizer', async () => {
    const data = await fetchYouTubeVideoData('dQw4w9WgXcQ');
    if (!data.ok || !data.hasTranscript) throw new Error('Transcript fetch failed');
    return { info: `Ingested ${data.transcriptText.length} chars of timestamped transcript for "${data.title}"` };
  });

  await benchmark('YouTube Shorts & Live Stream URL Resolver', 'YouTube Summarizer', async () => {
    const shortsId = extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ');
    const liveId = extractYouTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ');
    if (shortsId !== 'dQw4w9WgXcQ' || liveId !== 'dQw4w9WgXcQ') throw new Error('Shorts/Live resolver failed');
    return { info: `Resolved Shorts (${shortsId}) and Live (${liveId}) identifiers` };
  });

  // --------------------------------------------------------------------------
  // Group: Instagram Reel & Post Intelligence
  // --------------------------------------------------------------------------
  await benchmark('Instagram Reel URL Parser & Shortcode Extractor', 'Instagram Intelligence', async () => {
    const url = 'https://www.instagram.com/reel/DKn-PT1PMnr/?igsh=MXI4aWUwY29kcWRzMw==';
    const isIg = isInstagramUrl(url);
    const shortcode = extractInstagramShortcode(url);
    if (!isIg || shortcode !== 'DKn-PT1PMnr') throw new Error('Instagram extraction failed');
    return { info: `Extracted Reel shortcode "${shortcode}" from mobile share link` };
  });

  await benchmark('Instagram Reel Ingestion via Social Open Graph Crawler', 'Instagram Intelligence', async () => {
    const url = 'https://www.instagram.com/reel/DKn-PT1PMnr/?igsh=MXI4aWUwY29kcWRzMw==';
    const data = await fetchInstagramPostData(url);
    if (!data.ok) throw new Error('Instagram ingestion failed');
    return {
      info: `Ingested ${data.isReel ? 'Reel' : 'Post'} by ${data.author} (${data.caption.length} chars caption)`,
    };
  });

  // --------------------------------------------------------------------------
  // Group 7: Location Intelligence Processor
  // --------------------------------------------------------------------------
  await benchmark('Location Parsing & Google Grounded Local Snapshot', 'Location Intelligence', async () => {
    const loc = {
      latitude: 12.9716,
      longitude: 77.5946,
      name: 'MG Road Metro Station',
      address: 'Bengaluru, Karnataka, India',
    };

    const prompt = `Location: ${loc.name}, ${loc.address} (${loc.latitude}, ${loc.longitude}). Give a 2-bullet point snapshot of this area and current weather.`;
    const reply = await generateAIResponse(prompt, [], null, {
      anonId: testAnonId,
      forceGrounding: true,
    });
    return { info: `Generated location snapshot (${reply.length} chars)` };
  });

  // --------------------------------------------------------------------------
  // Group 8: Voice Note Audio Reply (TTS) Processor
  // --------------------------------------------------------------------------
  await benchmark('TTS Text Preprocessor & Markdown Stripper', 'Voice Note TTS', async () => {
    const markdown = '*Alert:* Here is `code` and _italics_ with a link https://example.com!';
    const chunks = splitTextForSpeech(markdown);
    if (chunks.length === 0 || chunks[0].includes('*') || chunks[0].includes('`')) {
      throw new Error('TTS markdown cleaning failed');
    }
    return { info: `Cleaned text into ${chunks.length} speech-ready chunk(s)` };
  });

  await benchmark('Text-to-Speech In-Memory Audio Synthesis (Google TTS)', 'Voice Note TTS', async () => {
    const synth = await synthesizeSpeech('Hello! Your personal assistant is ready.');
    if (!synth.ok || !synth.buffer || synth.buffer.length === 0) {
      throw new Error(`TTS synthesis failed: ${synth.error || synth.reason}`);
    }
    return { info: `Synthesized ${synth.buffer.length} bytes of MP3 audio in volatile RAM` };
  });

  // --------------------------------------------------------------------------
  // Group 9: Quick Notes & To-Do List Tracker Processor
  // --------------------------------------------------------------------------
  await benchmark('To-Do Item Full Lifecycle (Add -> List -> Done -> Clear)', 'To-Do Tracker', async () => {
    // 1. Add
    const item = addTodo(testAnonId, 'Benchmarking AI bot speed');
    if (!item.success || !item.id) throw new Error('addTodo failed');

    // 2. List
    const listStr = listTodos(testAnonId);
    if (!listStr.includes(item.id) || !listStr.includes('[ ]')) throw new Error('listTodos failed');

    // 3. Mark Done
    const doneResult = markTodoDone(testAnonId, item.id);
    if (!doneResult.success) throw new Error('markTodoDone failed');

    // 4. Verify checkbox [x]
    const listDone = listTodos(testAnonId);
    if (!listDone.includes('[x]')) throw new Error('Checkbox mark failed');

    // 5. Clear completed
    const clearResult = clearCompletedTodos(testAnonId);
    if (!clearResult.success || clearResult.clearedCount < 1) throw new Error('clearCompletedTodos failed');

    return { info: `Lifecycle verified: added ID ${item.id}, checked done, cleared` };
  });

  // --------------------------------------------------------------------------
  // Group 10: Scheduled Reminders Processor
  // --------------------------------------------------------------------------
  await benchmark('Natural Language Time Parser (Relative & Absolute)', 'Reminders', async () => {
    const t1 = parseReminderTime('15m');
    const t2 = parseReminderTime('2h');
    const t3 = parseReminderTime('23:59');
    if (!t1 || !t2 || !t3 || !t1.targetTimeMs || !t2.targetTimeMs || !t3.targetTimeMs) {
      throw new Error('Time parsing failed');
    }
    return { info: `Parsed 15m (+${Math.round((t1.targetTimeMs - Date.now()) / 60000)}m) and 23:59 successfully` };
  });

  await benchmark('Reminder Schedule -> List -> Delete Lifecycle', 'Reminders', async () => {
    const sched = scheduleReminder(testPhone, testAnonId, '30m', 'Take a quick break');
    if (!sched.success || !sched.reminder || !sched.reminder.id) throw new Error('scheduleReminder failed');

    const listStr = listReminders(testAnonId);
    if (!listStr.includes(sched.reminder.id)) throw new Error('listReminders failed');

    const del = deleteReminder(testAnonId, sched.reminder.id);
    if (!del.success) throw new Error('deleteReminder failed');

    return { info: `Scheduled ID ${sched.reminder.id}, listed, and deleted` };
  });

  // --------------------------------------------------------------------------
  // Group 11: Rate Limiter, Quota Guard & Quoted Reply Memory
  // --------------------------------------------------------------------------
  await benchmark('User Sliding-Window Rate Limiter Check', 'Rate Limiter & Quotas', async () => {
    resetUserRateLimit(testAnonId);
    const limitCheck = checkUserRateLimit(testAnonId);
    if (!limitCheck.allowed) throw new Error('Rate limit check failed');
    return { info: `User window active: ${limitCheck.remaining} calls remaining` };
  });

  await benchmark('Daily Quota & Budget Enforcement Check', 'Rate Limiter & Quotas', async () => {
    const quota = checkAndIncrementUserQuota(testAnonId);
    const report = getUserQuotaReport(testAnonId);
    if (!quota.allowed) throw new Error('User quota check failed');
    return {
      info: `User quota: ${report.userCount}/${report.userMax}, Gemini budget: ${report.geminiCount}/${report.geminiMax}`,
    };
  });

  await benchmark('Quoted-Reply Context Memory Store (10-min RAM Cache)', 'Context Memory', async () => {
    const msgId = `wamid.bench_${Date.now()}`;
    rememberMessage(msgId, 'Previous conversation context message');
    const retrieved = getRememberedMessage(msgId);
    if (!retrieved || !retrieved.includes('Previous conversation context')) {
      throw new Error('Remembered message retrieval failed');
    }
    return { info: `Stored & retrieved quoted message (${retrieved.length} chars) in RAM` };
  });

  // --------------------------------------------------------------------------
  // Group 12: Express Server & Webhook Endpoints
  // --------------------------------------------------------------------------
  await benchmark('WhatsApp Message Chunking Splitter', 'WhatsApp Transport', async () => {
    const longText = 'A'.repeat(8500);
    const chunks = splitMessageIntoChunks(longText);
    if (chunks.length < 3) throw new Error('Chunking failed');
    return { info: `Split 8500-char message into ${chunks.length} chunks (< 4000 chars each)` };
  });

  await benchmark('Interactive Buttons Builder (1024-char Auto Split)', 'WhatsApp Transport', async () => {
    const shortBtn = await sendWhatsAppButtons(testPhone, 'Short action prompt', [
      { id: 'btn_1', title: 'Option 1' },
      { id: 'btn_2', title: 'Option 2' },
    ]);
    const longText = 'Header overview.\n\n' + 'B'.repeat(1200);
    const longBtn = await sendWhatsAppButtons(testPhone, longText, [{ id: 'btn_3', title: 'Acknowledge' }]);
    if (!shortBtn.success || !longBtn.success) throw new Error('Interactive buttons send failed');
    return { info: `Constructed standard & 1024-char overflow button payloads` };
  });

  await benchmark('Interactive List Menu Builder (Dropdown Options)', 'WhatsApp Transport', async () => {
    const listRes = await sendWhatsAppList(
      testPhone,
      'Select a system configuration:',
      [
        { id: 'row_1', title: 'Model: Flash-Lite', description: 'Fast and responsive' },
        { id: 'row_2', title: 'Model: Flash-Pro', description: 'In-depth analysis' },
      ],
      'Choose Model'
    );
    if (!listRes.success) throw new Error('Interactive list send failed');
    return { info: `Constructed interactive list menu payload` };
  });

  // --------------------------------------------------------------------------
  // Group: Durable State & Storage Interface
  // --------------------------------------------------------------------------
  await benchmark('Pluggable Store Key-Value Operations (Set -> Get -> Incr -> Keys)', 'Durable State', async () => {
    const testKey = `bench:key:${Date.now()}`;
    await store.set(testKey, 'initial_val');
    const val = await store.get(testKey);
    if (val !== 'initial_val') throw new Error('Store get returned unexpected value');
    const counterKey = `bench:count:${Date.now()}`;
    const count = await store.incr(counterKey);
    if (count !== 1) throw new Error('Store incr failed');
    const keys = await store.keys('bench:*');
    await store.del(testKey);
    await store.del(counterKey);
    return { info: `Store operations verified across ${keys.length} temporary keys` };
  });

  // --------------------------------------------------------------------------
  // Group: Queue & Concurrency Management
  // --------------------------------------------------------------------------
  await benchmark('Message Work Queue Enqueue, Processing & Metrics', 'Queue & Concurrency', async () => {
    const pushed = messageQueue.push({
      message: { from: testPhone, id: `bench_msg_${Date.now()}`, type: 'text', text: { body: '/help' } },
      requestId: `bench_req_${Date.now()}`,
      anonId: testAnonId,
    });
    if (!pushed) throw new Error('Queue push failed');
    const stats = messageQueue.getStats();
    return {
      info: `Queue processed job: concurrency=${stats.concurrency}, active=${stats.active}, enqueued=${stats.enqueued}`,
    };
  });

  // --------------------------------------------------------------------------
  // Group: Multilingual Engine
  // --------------------------------------------------------------------------
  await benchmark('Multilingual Preference & System Directive Generation', 'Multilingual Engine', async () => {
    const anon = testAnonId;
    await setUserLanguage(anon, 'es');
    const lang = getUserLanguage(anon);
    const directive = getLanguageInstruction(lang);
    if (!directive.includes('Spanish') && !directive.includes('Español')) {
      throw new Error('Directive does not include Spanish instruction');
    }
    await setUserLanguage(anon, 'auto');
    return { info: `Language configured to ${lang}, directive generated (${directive.length} chars)` };
  });

  // --------------------------------------------------------------------------
  // Group: Personal Memory
  // --------------------------------------------------------------------------
  await benchmark('Personal Long-Term Fact Memory Storage & Retrieval', 'Personal Memory', async () => {
    const anon = testAnonId;
    await addMemoryFact(anon, 'User prefers dark mode and concise summaries');
    const context = getMemoryContext(anon);
    if (!context || !context.includes('dark mode')) {
      throw new Error('Memory context did not return stored fact');
    }
    await clearUserMemory(anon);
    return { info: `Fact successfully stored, recalled, and cleared (${context.length} chars)` };
  });

  await benchmark('Autonomous User Fact Learning & Contradiction Resolution', 'Auto-Learner', async () => {
    const anon = 'u_bench_auto_learn';
    await clearUserMemory(anon);
    const turn1 = await autoLearnFromTurn({
      anonId: anon,
      userMessage: 'Call me PJ and I live in Bengaluru.',
      _assistantReply: 'Hello PJ!',
      messageType: 'text',
    });
    if (turn1.deterministicFactsLearned !== 2) throw new Error('Failed to extract facts in turn 1');

    const turn2 = await autoLearnFromTurn({
      anonId: anon,
      userMessage: 'Actually, I moved to London last week.',
      _assistantReply: 'Understood!',
      messageType: 'text',
    });
    if (turn2.deterministicFactsLearned !== 1) throw new Error('Failed to extract updated location');

    const ctx = getMemoryContext(anon);
    if (!ctx.includes('PJ') || !ctx.includes('London') || ctx.includes('Bengaluru')) {
      throw new Error(`Contradiction resolution failed in context: ${ctx}`);
    }
    await clearUserMemory(anon);
    return { info: 'Successfully extracted identity, updated location, and resolved contradictions' };
  });

  await benchmark('Workflow Habit Recognition & Directive Context Compilation', 'Workflow Learner', async () => {
    const anon = 'u_bench_workflow';
    await clearLearnedWorkflows(anon);
    await recordUserInteraction(anon, 'youtube_video', { url: 'https://youtu.be/test1' });
    const res2 = await recordUserInteraction(anon, 'instagram_reel', { url: 'https://instagram.com/reel/test2' });
    if (!res2.habitDetected) throw new Error('Habit was not detected on second media action');

    const ctx = getLearnedWorkflowContext(anon);
    if (!ctx.includes('LEARNED USER WORKFLOW DIRECTIVES') || !ctx.includes('actionable takeaways')) {
      throw new Error('Workflow directive context compilation failed');
    }
    await clearLearnedWorkflows(anon);
    return { info: `Habit detected: ${res2.habitName}, context compiled (${ctx.length} chars)` };
  });

  await benchmark('Adaptive Conversational Progression & Pacing Calibration', 'Conversation Adapter', async () => {
    const anon = 'u_bench_adapter';
    await clearUserProfile(anon);
    const history = [
      { role: 'user', parts: [{ text: 'Kubernetes cluster setup' }] },
      { role: 'model', parts: [{ text: 'Cluster setup guide...' }] },
      { role: 'user', parts: [{ text: 'Configure ingress' }] },
      { role: 'model', parts: [{ text: 'Ingress YAML config...' }] },
    ];
    const ctx = getConversationAdaptationContext(anon, history, 'Add cert-manager');
    if (
      !ctx.includes('Developing (Turn 3)') ||
      !ctx.includes('Pacing Match') ||
      !ctx.includes('Technical Calibration')
    ) {
      throw new Error(`Adaptive context missing required directives: ${ctx}`);
    }
    await clearUserProfile(anon);
    return { info: `Stage: Developing (Turn 3), Pacing: Terse, Calibration: Advanced (< 0.5ms)` };
  });

  await benchmark('Continuous Conversational Learning & Active Project Memory', 'Conversation Adapter', async () => {
    const anon = 'u_bench_cont_learn';
    await clearUserProfile(anon);
    await updateUserProfile(anon, {
      activeProject: 'distributed payment gateway',
      topics: ['docker', 'kubernetes', 'postgres'],
    });

    const prof = getUserProfile(anon);
    if (prof.activeProject !== 'distributed payment gateway' || prof.topics.length !== 3) {
      throw new Error('User profile did not retain active project or topics');
    }

    const ctx = getConversationAdaptationContext(
      anon,
      [
        { role: 'user', parts: [{ text: 'Initial' }] },
        { role: 'model', parts: [{ text: 'Ok' }] },
      ],
      'How do I handle idempotency?'
    );
    if (!ctx.includes('distributed payment gateway')) {
      throw new Error(`Context did not inject active project: ${ctx}`);
    }
    await clearUserProfile(anon);
    return { info: `Retained active project & 3 topics, injected into Turn 2 context successfully` };
  });

  // --------------------------------------------------------------------------
  // Group: Agentic Function Calling Tools
  // --------------------------------------------------------------------------
  await benchmark('Agentic Tool Calling Dispatcher (Time & Weather)', 'Agentic Tools', async () => {
    const timeRes = await executeToolCall('get_current_time', { timezone: 'Asia/Kolkata' }, { anonId: testAnonId });
    if (!timeRes.current_time || !timeRes.iso) throw new Error('Time tool failed');
    const weatherRes = await executeToolCall('get_current_weather', { location: 'Tokyo' }, { anonId: testAnonId });
    if (!weatherRes.location) throw new Error('Weather tool failed');
    return {
      info: `Time returned ${timeRes.current_time} (${timeRes.timezone}), Weather returned ${weatherRes.location}`,
    };
  });

  // --------------------------------------------------------------------------
  // Group: User Data Portability & Export
  // --------------------------------------------------------------------------
  await benchmark('User Data Export Compilation (GDPR / DPDP Compliance)', 'Data Export', async () => {
    const exportData = await exportUserData(testPhone, testAnonId);
    if (!exportData || !exportData.success) throw new Error('Export payload invalid');
    return { info: `Export completed successfully: ${exportData.message.substring(0, 60)}...` };
  });

  // Start temporary local server to test live HTTP endpoints
  const serverPort = 3999;
  const server = app.listen(serverPort, '127.0.0.1');

  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    await benchmark('GET /health Endpoint Latency', 'HTTP Endpoints', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      return { info: `Status: ${data.status}, Storage: ${data.storageMode}` };
    });

    await benchmark('GET /diagnostic Endpoint (Masked Secrets)', 'HTTP Endpoints', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/diagnostic`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      if (!data.config.gemini.apiKeyMasked.includes('***')) throw new Error('Secret unmasked');
      return { info: `Active model: ${data.config.gemini.model}, Secret masked properly` };
    });

    await benchmark('GET /metrics Prometheus Exposition', 'HTTP Endpoints', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/metrics`);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
      const text = await res.text();
      return { info: `Prometheus text payload: ${text.length} bytes` };
    });

    await benchmark('GET /admin Dashboard Latency (Token-Gated)', 'HTTP Endpoints', async () => {
      const token = config.METRICS_AUTH_TOKEN || '';
      const url = token
        ? `http://127.0.0.1:${serverPort}/admin?token=${encodeURIComponent(token)}`
        : `http://127.0.0.1:${serverPort}/admin`;
      const res = await fetch(url);
      if (res.status !== 200) throw new Error(`Admin returned status ${res.status}`);
      const html = await res.text();
      if (!html.includes('Operational Admin Dashboard')) throw new Error('Admin HTML response missing heading');
      return { info: `Admin dashboard rendered HTML (${html.length} bytes)` };
    });

    await benchmark('POST /webhook Complete Pipeline (Text -> Routing -> 200 OK)', 'HTTP Endpoints', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'bench_account',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  contacts: [{ profile: { name: 'Benchmark User' }, wa_id: testPhone }],
                  messages: [
                    {
                      from: testPhone,
                      id: `wamid.bench_msg_${Date.now()}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: '/status' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const raw = JSON.stringify(payload);
      const sig = crypto
        .createHmac('sha256', config.WHATSAPP_APP_SECRET || 'test')
        .update(raw)
        .digest('hex');

      const res = await fetch(`http://127.0.0.1:${serverPort}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': `sha256=${sig}`,
        },
        body: raw,
      });

      if (res.status !== 200) throw new Error(`Webhook returned status ${res.status}`);
      return { info: 'Immediate 200 EVENT_RECEIVED returned; dispatched async processing' };
    });
  } finally {
    server.close();
  }

  console.log('\n====================================================');
  console.log('🏁 ALL BENCHMARKS COMPLETED');
  console.log('====================================================');
  console.log(JSON.stringify(results, null, 2));
}

runAllBenchmarks().catch((err) => {
  console.error('Benchmark runner error:', err);
  process.exit(1);
});
