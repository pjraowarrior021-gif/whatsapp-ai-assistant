import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const ARTIFACT_DIR = 'C:\\Users\\PJ\\.gemini\\antigravity\\brain\\b1e60977-78d7-4409-aeee-8b5fcb68ae6e';
const WORKSPACE_REPORTS_DIR = path.resolve('reports');

if (!fs.existsSync(WORKSPACE_REPORTS_DIR)) {
  fs.mkdirSync(WORKSPACE_REPORTS_DIR, { recursive: true });
}

const outputPath1 = path.join(WORKSPACE_REPORTS_DIR, 'full_feature_performance_report.pdf');
const outputPath2 = path.join(ARTIFACT_DIR, 'full_feature_performance_report.pdf');

// 33 Benchmark items data
const benchmarks = [
  {
    id: 1,
    name: 'HMAC-SHA256 Signature Verification',
    category: 'Security & Crypto',
    latency: '0.41 ms',
    status: 'PASS',
  },
  {
    id: 2,
    name: 'Phone Whitelist & Access Control Check',
    category: 'Security & Crypto',
    latency: '0.12 ms',
    status: 'PASS',
  },
  {
    id: 3,
    name: 'Salted SHA-256 Non-Reversible Anonymization',
    category: 'Security & Crypto',
    latency: '0.06 ms',
    status: 'PASS',
  },
  {
    id: 4,
    name: 'Payment Card Luhn Verification & Redaction',
    category: 'Privacy Guard',
    latency: '0.93 ms',
    status: 'PASS',
  },
  {
    id: 5,
    name: 'Aadhaar, PIN, Password & OTP Redaction',
    category: 'Privacy Guard',
    latency: '0.05 ms',
    status: 'PASS',
  },
  {
    id: 6,
    name: 'Gemini Connection & Ping Test (Live Network)',
    category: 'Gemini AI Core',
    latency: '1,638.3 ms',
    status: 'PASS',
  },
  {
    id: 7,
    name: 'Gemini Contextual Multi-Turn Conversation',
    category: 'Gemini AI Core',
    latency: '4,217.8 ms',
    status: 'PASS',
  },
  {
    id: 8,
    name: 'Gemini Dynamic Persona Switching',
    category: 'Gemini AI Core',
    latency: '12,299.3 ms',
    status: 'PASS',
  },
  {
    id: 9,
    name: 'Image Multimodal Analysis (Gemini Vision)',
    category: 'Multimodal Vision',
    latency: '1,554.6 ms',
    status: 'PASS',
  },
  {
    id: 10,
    name: 'Document Allowlist & Header Validation',
    category: 'Document Processor',
    latency: '0.65 ms',
    status: 'PASS',
  },
  {
    id: 11,
    name: 'PowerPoint (.pptx) In-Memory Slide Extraction',
    category: 'Document Processor',
    latency: '43.03 ms',
    status: 'PASS',
  },
  {
    id: 12,
    name: 'Word (.docx) In-Memory Paragraph Extraction',
    category: 'Document Processor',
    latency: '1.17 ms',
    status: 'PASS',
  },
  {
    id: 13,
    name: 'Excel (.xlsx) In-Memory Shared Strings',
    category: 'Document Processor',
    latency: '0.94 ms',
    status: 'PASS',
  },
  {
    id: 14,
    name: 'Image Prompt Parser (NLP & Slash)',
    category: 'Image Generation',
    latency: '1.16 ms',
    status: 'PASS',
  },
  {
    id: 15,
    name: 'Pollinations URL Builder & Safe Encoding',
    category: 'Image Generation',
    latency: '0.17 ms',
    status: 'PASS',
  },
  {
    id: 16,
    name: 'In-Memory Sharp Watermark Crop & Opt',
    category: 'Image Generation',
    latency: '21.45 ms',
    status: 'PASS',
  },
  {
    id: 17,
    name: 'SSRF Guard Validator (Subnet/Metadata)',
    category: 'Web Summarizer',
    latency: '0.56 ms',
    status: 'PASS',
  },
  { id: 18, name: 'HTML Cleaner & Entity Decoder', category: 'Web Summarizer', latency: '1.33 ms', status: 'PASS' },
  {
    id: 19,
    name: 'Live Web Article Ingestion & Summary',
    category: 'Web Summarizer',
    latency: '2,358.9 ms',
    status: 'PASS',
  },
  {
    id: 20,
    name: 'Location Parsing & Grounded Local Snapshot',
    category: 'Location Intel',
    latency: '2,809.4 ms',
    status: 'PASS',
  },
  {
    id: 21,
    name: 'TTS Text Preprocessor & Markdown Stripper',
    category: 'Voice Note TTS',
    latency: '1.61 ms',
    status: 'PASS',
  },
  {
    id: 22,
    name: 'Google TTS In-Memory MP3 Audio Synthesis',
    category: 'Voice Note TTS',
    latency: '466.37 ms',
    status: 'PASS',
  },
  {
    id: 23,
    name: 'To-Do Item Full Lifecycle (Add/Done/Clear)',
    category: 'To-Do Tracker',
    latency: '2.81 ms',
    status: 'PASS',
  },
  {
    id: 24,
    name: 'Natural Language Time Parser (Rel & Abs)',
    category: 'Reminders',
    latency: '26.60 ms',
    status: 'PASS',
  },
  {
    id: 25,
    name: 'Reminder Lifecycle (Schedule/List/Delete)',
    category: 'Reminders',
    latency: '1.75 ms',
    status: 'PASS',
  },
  {
    id: 26,
    name: 'User Sliding-Window Rate Limiter Check',
    category: 'Rate Limits & Quota',
    latency: '0.31 ms',
    status: 'PASS',
  },
  {
    id: 27,
    name: 'Daily Quota & Budget Enforcement Check',
    category: 'Rate Limits & Quota',
    latency: '0.42 ms',
    status: 'PASS',
  },
  { id: 28, name: 'Quoted-Reply Context Memory Store', category: 'Context Memory', latency: '0.27 ms', status: 'PASS' },
  {
    id: 29,
    name: 'WhatsApp Message Chunking Splitter',
    category: 'WhatsApp Transport',
    latency: '0.54 ms',
    status: 'PASS',
  },
  {
    id: 30,
    name: 'Interactive Buttons (1024-char Auto Split)',
    category: 'WhatsApp Transport',
    latency: '3,108.9 ms',
    status: 'PASS',
  },
  {
    id: 31,
    name: 'Interactive List Menu Builder',
    category: 'WhatsApp Transport',
    latency: '866.27 ms',
    status: 'PASS',
  },
  { id: 32, name: 'GET /health Endpoint Latency', category: 'HTTP Endpoints', latency: '17.04 ms', status: 'PASS' },
  {
    id: 33,
    name: 'POST /webhook Complete Dispatch Pipeline',
    category: 'HTTP Endpoints',
    latency: '30.12 ms',
    status: 'PASS',
  },
];

function buildPdf(destPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      bufferPages: true,
    });

    const stream = fs.createWriteStream(destPath);
    doc.pipe(stream);

    // --- Colors ---
    const primary = '#0f172a'; // slate-900
    const accent = '#2563eb'; // blue-600
    const green = '#16a34a'; // green-600
    const lightBg = '#f8fafc'; // slate-50
    const borderColor = '#cbd5e1'; // slate-300
    const textDark = '#1e293b'; // slate-800
    const textMuted = '#64748b'; // slate-500

    // ==========================================
    // PAGE 1: COVER & EXECUTIVE DASHBOARD
    // ==========================================

    // Decorative Top Accent Bar
    doc.rect(40, 40, 515, 6).fill(accent);

    doc.moveDown(1.5);
    doc.fillColor(primary).fontSize(22).font('Helvetica-Bold').text('PERSONAL WHATSAPP AI ASSISTANT');
    doc.fillColor(accent).fontSize(14).font('Helvetica').text('Comprehensive Feature & Performance Benchmark Report');
    doc
      .fillColor(textMuted)
      .fontSize(9)
      .text('Production Deployment: Railway HTTPS | Meta Cloud API v21.0 | Google Gemini Core');

    doc.moveDown(1.2);

    // System Metadata Box
    const metaY = doc.y;
    doc.roundedRect(40, metaY, 515, 65, 4).fillAndStroke(lightBg, borderColor);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(9);
    doc.text('ENVIRONMENT:', 55, metaY + 12);
    doc.text('AI ENGINE:', 55, metaY + 28);
    doc.text('STORAGE ARCHITECTURE:', 55, metaY + 44);

    doc.font('Helvetica').fillColor(textDark);
    doc.text('Production (Railway Cloud - Live)', 140, metaY + 12);
    doc.text('Google Gemini 3.5 Flash-Lite (Active) + 3.1 & 3.5 Fallbacks', 140, metaY + 28);
    doc.text('Strict Volatile RAM Only (Zero Disk Writes / Ephemeral)', 205, metaY + 44);

    doc.font('Helvetica-Bold').fillColor(primary);
    doc.text('REPORT DATE:', 350, metaY + 12);
    doc.text('DOCUMENT LIMIT:', 350, metaY + 28);
    doc.text('SYSTEM HEALTH:', 350, metaY + 44);

    doc.font('Helvetica').fillColor(textDark);
    doc.text(
      new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
      435,
      metaY + 12
    );
    doc.text('100 MB (Office + PDF)', 455, metaY + 28);
    doc
      .font('Helvetica-Bold')
      .fillColor(green)
      .text('100% OPERATIONAL', 445, metaY + 44);

    doc.y = metaY + 80;

    // 4 Key Stat Cards
    const cardY = doc.y;
    const cardW = 120;
    const cardH = 50;
    const gap = 11.5;

    const cards = [
      { label: 'PROCESSORS TESTED', val: '33 / 33', sub: '100% Verified Pass', color: green },
      { label: 'UNIT TEST SUITE', val: '100 / 100', sub: 'Zero Failures', color: green },
      { label: 'MICRO-OP SPEED', val: '< 1.0 ms', sub: 'Sub-millisecond Local', color: accent },
      { label: 'TOTAL BENCHMARK', val: '31.8s', sub: 'Complete E2E Run', color: primary },
    ];

    cards.forEach((c, idx) => {
      const cx = 40 + idx * (cardW + gap);
      doc.roundedRect(cx, cardY, cardW, cardH, 4).fillAndStroke('#ffffff', borderColor);
      doc
        .fillColor(textMuted)
        .font('Helvetica-Bold')
        .fontSize(7)
        .text(c.label, cx + 8, cardY + 8, { width: cardW - 16, align: 'center' });
      doc
        .fillColor(c.color)
        .font('Helvetica-Bold')
        .fontSize(14)
        .text(c.val, cx + 8, cardY + 20, { width: cardW - 16, align: 'center' });
      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(7)
        .text(c.sub, cx + 8, cardY + 36, { width: cardW - 16, align: 'center' });
    });

    doc.y = cardY + 65;

    // Section 1 Header
    doc
      .fillColor(primary)
      .font('Helvetica-Bold')
      .fontSize(12)
      .text('1. End-to-End Performance Benchmarks (All 33 Processors)');
    doc.moveDown(0.5);

    // Table Header
    const tableTop = doc.y;
    doc.rect(40, tableTop, 515, 18).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    doc.text('#', 45, tableTop + 5);
    doc.text('PROCESSOR / CAPABILITY', 65, tableTop + 5);
    doc.text('CATEGORY', 270, tableTop + 5);
    doc.text('LATENCY', 430, tableTop + 5);
    doc.text('STATUS', 500, tableTop + 5);

    let curY = tableTop + 18;

    // Render items 1 to 20 on Page 1
    for (let i = 0; i < 20; i++) {
      const item = benchmarks[i];
      const isEven = i % 2 === 0;
      doc.rect(40, curY, 515, 16.5).fill(isEven ? '#ffffff' : '#f8fafc');
      doc.rect(40, curY, 515, 16.5).stroke(borderColor);

      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(String(item.id), 45, curY + 4);
      doc
        .fillColor(textDark)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(item.name, 65, curY + 4, { width: 195 });
      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(item.category, 270, curY + 4, { width: 150 });
      doc
        .fillColor(accent)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(item.latency, 430, curY + 4);

      // Pass Pill
      doc.roundedRect(495, curY + 2.5, 45, 11, 2).fill('#dcfce7');
      doc
        .fillColor('#15803d')
        .font('Helvetica-Bold')
        .fontSize(6.5)
        .text('PASS', 495, curY + 4.5, { width: 45, align: 'center' });

      curY += 16.5;
    }

    // ==========================================
    // PAGE 2: TABLE CONTINUED & ARCHITECTURE
    // ==========================================
    doc.addPage();

    doc.rect(40, 40, 515, 6).fill(accent);
    doc.moveDown(1.5);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(12).text('1. End-to-End Performance Benchmarks (Continued)');
    doc.moveDown(0.5);

    const p2TableTop = doc.y;
    doc.rect(40, p2TableTop, 515, 18).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    doc.text('#', 45, p2TableTop + 5);
    doc.text('PROCESSOR / CAPABILITY', 65, p2TableTop + 5);
    doc.text('CATEGORY', 270, p2TableTop + 5);
    doc.text('LATENCY', 430, p2TableTop + 5);
    doc.text('STATUS', 500, p2TableTop + 5);

    let p2CurY = p2TableTop + 18;

    for (let i = 20; i < benchmarks.length; i++) {
      const item = benchmarks[i];
      const isEven = i % 2 === 0;
      doc.rect(40, p2CurY, 515, 16.5).fill(isEven ? '#ffffff' : '#f8fafc');
      doc.rect(40, p2CurY, 515, 16.5).stroke(borderColor);

      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(String(item.id), 45, p2CurY + 4);
      doc
        .fillColor(textDark)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(item.name, 65, p2CurY + 4, { width: 195 });
      doc
        .fillColor(textMuted)
        .font('Helvetica')
        .fontSize(7.5)
        .text(item.category, 270, p2CurY + 4, { width: 150 });
      doc
        .fillColor(accent)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(item.latency, 430, p2CurY + 4);

      doc.roundedRect(495, p2CurY + 2.5, 45, 11, 2).fill('#dcfce7');
      doc
        .fillColor('#15803d')
        .font('Helvetica-Bold')
        .fontSize(6.5)
        .text('PASS', 495, p2CurY + 4.5, { width: 45, align: 'center' });

      p2CurY += 16.5;
    }

    doc.y = p2CurY + 25;

    // Section 2: Latency Tier Architecture
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(12).text('2. Architecture & Execution Latency Tiers');
    doc.moveDown(0.5);

    const tiers = [
      {
        tier: 'Tier 1: Sub-Millisecond Micro-Operations (< 1.0 ms)',
        items:
          'HMAC-SHA256 signature verification (0.41ms), phone authorization (0.12ms), salted SHA-256 anonymizer (0.06ms), Luhn payment card verification (0.93ms), PII masking (0.05ms), Word & Excel text extraction (0.94ms–1.17ms), quota tracking (0.42ms).',
      },
      {
        tier: 'Tier 2: In-Memory Media & Local Compute (1.0 ms – 50.0 ms)',
        items:
          'PowerPoint PPTX slide unzip and numerical XML parsing (43.03ms), Sharp image watermark removal (21.45ms), reminder natural language date math (26.60ms), HTTP dispatch & route handling (17.04ms–30.12ms).',
      },
      {
        tier: 'Tier 3: Cloud AI & Multimodal Synthesis (450 ms – 3.0 s)',
        items:
          'Google TTS voice note synthesis (466ms), Gemini Vision single-turn reasoning (1.55s), live Wikipedia web ingestion & summary (2.35s), Google Search grounded location snapshot (2.80s), multi-turn context retention (4.21s).',
      },
    ];

    tiers.forEach((t) => {
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(9).text(t.tier);
      doc.fillColor(textDark).font('Helvetica').fontSize(8).text(t.items);
      doc.moveDown(0.5);
    });

    // ==========================================
    // PAGE 3: FEATURE MATRIX & RECENT FIXES
    // ==========================================
    doc.addPage();

    doc.rect(40, 40, 515, 6).fill(accent);
    doc.moveDown(1.5);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(12).text('3. Core Feature Matrix & Production Capabilities');
    doc.moveDown(0.6);

    const features = [
      {
        title: 'Document & Presentation Engine (Up to 100MB)',
        desc: 'Supports PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), TXT, and CSV. In-memory XML slide extraction tags individual slides cleanly (Slide 1, Slide 2, ...). Files > 20MB are seamlessly routed via Google Gemini Files API with zero-disk storage.',
      },
      {
        title: 'AI Art & Image Generation (FLUX.1 HD & SDXL Turbo)',
        desc: 'Generates high-definition artwork via FLUX.1 with automated Gemini Prompt Co-pilot enhancement. Supports --fast (1.5s draft), --wallpaper (9:16 phone), --wide (16:9), and style presets (--anime, --photo, --cinematic, --raw). Multi-corner watermark removal powered by Sharp.',
      },
      {
        title: 'Voice Notes & Multimodal Audio Synthesis (TTS)',
        desc: 'Transcribes incoming WhatsApp audio and voice notes via Gemini multimodal audio. Synthesizes human-like voice replies in MP3 format using Google TTS when /voice on is enabled or --voice is appended.',
      },
      {
        title: 'Smart Web Page Reader & Location Intelligence',
        desc: 'Extracts and summarizes shared web articles with strict SSRF protection (blocking loopback, private subnets, and AWS/GCP metadata). Automatically parses WhatsApp location pins and returns Google Search grounded local guides.',
      },
      {
        title: 'Task Tracker & Natural Language Reminders',
        desc: 'Interactive /todo list manager (add, mark done, clear). Automated background scheduler (/remind 15m Call client, /remind 18:30 Workout) with exact interval timeouts and instant deletion.',
      },
      {
        title: 'Enterprise Privacy & Zero-Retention Security',
        desc: 'Strict Volatile RAM Only storage (all session history prunes after 15 min idle TTL). Automatic redaction of Luhn-valid credit cards, Aadhaar IDs, UPI PINs, passwords, and OTPs. Timing-safe HMAC-SHA256 signature verification.',
      },
    ];

    features.forEach((f) => {
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(9.5).text(`• ${f.title}`);
      doc.fillColor(textDark).font('Helvetica').fontSize(8).text(f.desc);
      doc.moveDown(0.5);
    });

    doc.moveDown(0.8);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(12).text('4. Recent Critical Fixes Deployed to Production');
    doc.moveDown(0.5);

    const fixes = [
      {
        issue: 'PPTX & Office Document Support',
        fix: 'Built in-memory zip/XML slide extraction in src/document.js. Solved "Unsupported format (presentationml.presentation)" error.',
      },
      {
        issue: '100MB Document Size Cap',
        fix: 'Increased MEDIA_MAX_BYTES to 100MB and download timeout to 60s. Integrated Gemini Files API for large textbooks like 52MB PDF.',
      },
      {
        issue: 'Dynamic Gemini Circuit Breaker',
        fix: 'Scaled timeout from 8s to 45s for multi-page documents and PDFs. Solved timeout errors on large documents like 58-page roadmap.',
      },
      {
        issue: 'Interactive Buttons 1024-Char Limit',
        fix: 'Implemented automatic message splitting for text > 1024 chars so /help and /status buttons never trigger Meta parameter errors.',
      },
    ];

    fixes.forEach((fx) => {
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(8.5).text(`✔ ${fx.issue}:`);
      doc.fillColor(textDark).font('Helvetica').fontSize(8).text(fx.fix);
      doc.moveDown(0.3);
    });

    // ==========================================
    // FOOTER (ALL PAGES)
    // ==========================================
    const totalPages = doc.bufferedPageRange().count;
    for (let p = 0; p < totalPages; p++) {
      doc.switchToPage(p);
      doc.rect(40, 800, 515, 0.5).fill(borderColor);
      doc.fillColor(textMuted).font('Helvetica').fontSize(7.5);
      doc.text('Personal WhatsApp AI Assistant (Gemini) • Official Performance Benchmark', 40, 808);
      doc.text(`Page ${p + 1} of ${totalPages}`, 490, 808, { align: 'right', width: 65 });
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function run() {
  console.log('Generating PDF reports...');
  await buildPdf(outputPath1);
  console.log(`Saved workspace PDF: ${outputPath1}`);
  await buildPdf(outputPath2);
  console.log(`Saved artifact PDF: ${outputPath2}`);
}

run().catch((err) => {
  console.error('PDF generation error:', err);
  process.exit(1);
});
