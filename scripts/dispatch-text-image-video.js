import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateCleanImage } from '../src/image-gen.js';
import { sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppVideo } from '../src/whatsapp.js';
import { config } from '../src/config.js';

const TARGET_PHONE = '918217426307';
const ARTIFACT_DIR = 'C:\\Users\\PJ\\.gemini\\antigravity\\brain\\b1e60977-78d7-4409-aeee-8b5fcb68ae6e';
const REPORTS_DIR = path.resolve('reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function persistFile(filename, buffer) {
  const repPath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(repPath, buffer);
  if (fs.existsSync(ARTIFACT_DIR)) {
    const artPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(artPath, buffer);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('========================================================');
  console.log(`🚀 OUTBOUND DISPATCH VERIFICATION: TEXT, IMAGE & VIDEO`);
  console.log(`📱 Recipient: +${TARGET_PHONE}`);
  console.log(`⏱️  Timestamp: ${new Date().toISOString()}`);
  console.log('========================================================\n');

  const report = {
    targetPhone: TARGET_PHONE,
    timestamp: new Date().toISOString(),
    items: {},
  };

  // ----------------------------------------------------
  // STEP 1: SEND FORMATTED TEXT MESSAGE
  // ----------------------------------------------------
  console.log('1️⃣  Dispatching WhatsApp Text Message...');
  const textContent = [
    '🤖 *Personal AI Assistant — Live Verification*',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '✅ *System Status:* Online & Verified (Railway Production)',
    '✨ *AI Model:* Gemini 3.1 Flash-Lite + Router Engine',
    '🎨 *Image Engine:* FLUX.1 (HD 1024x1024 Watermark-Free)',
    '💬 *Typing Indicator:* Native Animated Status Enabled',
    '⚡ *Webhook Latency:* < 15ms | Storage: Volatile In-Memory',
    '',
    '📥 *Inbound Test Sequence:*',
    '• 1/3: Formatted Text Dispatch (Current)',
    '• 2/3: High-Definition AI Image (FLUX.1 Schnell)',
    '• 3/3: ISO MP4 Motion Video Clip',
    '',
    'Type `/help` or `/dashboard` anytime for full mission control.',
  ].join('\n');

  const tStartText = performance.now();
  const textRes = await sendWhatsAppMessage(TARGET_PHONE, textContent);
  const textDurationMs = Math.round(performance.now() - tStartText);

  report.items.text = {
    success: textRes.success,
    messageId: textRes.messageIds?.[0] || null,
    latencyMs: textDurationMs,
    length: textContent.length,
  };

  console.log(`   Text Dispatch Result: ${textRes.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`   WAMID: ${report.items.text.messageId}`);
  console.log(`   Latency: ${textDurationMs}ms\n`);

  await sleep(2500);

  // ----------------------------------------------------
  // STEP 2: GENERATE & DISPATCH HD AI IMAGE
  // ----------------------------------------------------
  console.log('2️⃣  Generating & Dispatching AI Image...');
  const imagePrompt =
    'A high-speed tracking shot of a McLaren Senna hypercar cutting through the Eau Rouge curve at Spa-Francorchamps, exposed gloss carbon-fiber bodywork with electric yellow and green Brazilian tribute accents, glowing red carbon-ceramic brake rotors, heat haze rising from active rear wing, photorealistic 8k, cinematic lighting --wide';

  const tStartImgGen = performance.now();
  console.log('   Generating watermark-free image via FLUX.1...');
  const cleanImage = await generateCleanImage(imagePrompt, {
    width: 1280,
    height: 720,
    model: 'flux',
    style: 'cinematic',
  });
  const imgGenDurationMs = Math.round(performance.now() - tStartImgGen);

  if (cleanImage && cleanImage.buffer) {
    const imgSize = cleanImage.buffer.length;
    persistFile('test_dispatch_mclaren_senna.jpg', cleanImage.buffer);
    console.log(`   Generated Image: ${imgSize} bytes in ${imgGenDurationMs}ms`);

    const imgCaption = [
      '🏎️ *McLaren Senna Hypercar — Eau Rouge*',
      '• *Model:* FLUX.1 Schnell (HD)',
      '• *Dimensions:* 1280x720 (16:9 Cinematic)',
      '• *Processing:* Lanczos3 Clean Excision (Watermark-Free)',
    ].join('\n');

    const tStartImgSend = performance.now();
    const imgSendRes = await sendWhatsAppImage(TARGET_PHONE, cleanImage.buffer, imgCaption);
    const imgSendDurationMs = Math.round(performance.now() - tStartImgSend);

    report.items.image = {
      success: imgSendRes.success,
      messageId: imgSendRes.messageId || null,
      fileSize: imgSize,
      genLatencyMs: imgGenDurationMs,
      sendLatencyMs: imgSendDurationMs,
      prompt: imagePrompt,
    };

    console.log(`   Image Dispatch Result: ${imgSendRes.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   WAMID: ${report.items.image.messageId}`);
    console.log(`   Upload & Send Latency: ${imgSendDurationMs}ms\n`);
  } else {
    report.items.image = { success: false, error: 'Image generation failed' };
    console.error('   ❌ Failed to generate image');
  }

  await sleep(3000);

  // ----------------------------------------------------
  // STEP 3: PREPARE & DISPATCH TEST VIDEO
  // ----------------------------------------------------
  console.log('3️⃣  Fetching & Dispatching Motion Video Clip...');
  const videoUrl = 'https://www.w3schools.com/html/mov_bbb.mp4';
  const tStartVidFetch = performance.now();

  try {
    const vidResp = await fetch(videoUrl);
    if (vidResp.ok) {
      const vidArr = await vidResp.arrayBuffer();
      const vidBuffer = Buffer.from(vidArr);
      const vidFetchDurationMs = Math.round(performance.now() - tStartVidFetch);

      persistFile('test_dispatch_motion_video.mp4', vidBuffer);
      console.log(`   Fetched Video Stream: ${vidBuffer.length} bytes in ${vidFetchDurationMs}ms`);

      const vidCaption = [
        '🎬 *Motion Video Demonstration*',
        '• *Format:* ISO MP4 / H.264 Video Stream',
        '• *Duration:* High-Definition Playback',
        '• *Delivery:* Native WhatsApp Media Upload',
      ].join('\n');

      const tStartVidSend = performance.now();
      const vidSendRes = await sendWhatsAppVideo(TARGET_PHONE, vidBuffer, vidCaption);
      const vidSendDurationMs = Math.round(performance.now() - tStartVidSend);

      report.items.video = {
        success: vidSendRes.success,
        messageId: vidSendRes.messageId || null,
        fileSize: vidBuffer.length,
        fetchLatencyMs: vidFetchDurationMs,
        sendLatencyMs: vidSendDurationMs,
      };

      console.log(`   Video Dispatch Result: ${vidSendRes.success ? '✅ SUCCESS' : '❌ FAILED'}`);
      console.log(`   WAMID: ${report.items.video.messageId}`);
      console.log(`   Upload & Send Latency: ${vidSendDurationMs}ms\n`);
    } else {
      report.items.video = { success: false, error: `HTTP ${vidResp.status}` };
      console.error(`   ❌ Failed to fetch video stream: HTTP ${vidResp.status}`);
    }
  } catch (err) {
    report.items.video = { success: false, error: err.message };
    console.error(`   ❌ Video error: ${err.message}`);
  }

  console.log('========================================================');
  console.log('📊 FINAL DISPATCH SUMMARY:');
  console.log(JSON.stringify(report, null, 2));
  console.log('========================================================');

  // Save JSON report
  fs.writeFileSync(path.join(REPORTS_DIR, 'dispatch_report.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
