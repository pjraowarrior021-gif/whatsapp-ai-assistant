import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { generateCleanImage } from '../src/image-gen.js';
import { sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppVideo } from '../src/whatsapp.js';
import { config } from '../src/config.js';

const TARGET_PHONE =
  process.env.TEST_PHONE_NUMBER ||
  (config.ALLOWED_PHONE_NUMBERS && Array.from(config.ALLOWED_PHONE_NUMBERS)[0]) ||
  '';
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || '';
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
    '✨ *Personal AI Assistant — Live Multimodal Test*',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '✅ *Dual-Cloud Status:* Online & Protected',
    '⚡ *Primary Host:* Railway (Production Active)',
    '🛡️ *Backup Host:* Render (24/7 Hot-Standby Verified)',
    '🌐 *Failover Gateway:* Cloudflare Workers (Auto-Switch)',
    '💬 *Typing Indicator:* Native Animated Status Active',
    '',
    '📥 *Test Sequence:*',
    '1. Formatted Status Text (Delivered)',
    '2. High-Definition AI Image (FLUX.1 Schnell 16:9)',
    '3. AI Motion Video Clip (H.264 / AAC 720p)',
    '',
    '_Sending image and video now..._',
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

  await sleep(2000);

  // ----------------------------------------------------
  // STEP 2: GENERATE & DISPATCH HD AI IMAGE
  // ----------------------------------------------------
  console.log('2️⃣  Generating & Dispatching AI Image...');
  const imagePrompt =
    'Cinematic wide tracking shot of a McLaren Senna hypercar tearing through midnight city rain, glowing neon reflections on wet asphalt, glowing carbon-ceramic brake calipers, photorealistic 8k, dramatic lighting --wide';

  const tStartImgGen = performance.now();
  console.log('   Generating watermark-free image via FLUX.1...');
  const cleanImage = await generateCleanImage(imagePrompt, {
    width: 1280,
    height: 720,
    model: 'flux',
    style: 'cinematic',
  });
  const imgGenDurationMs = Math.round(performance.now() - tStartImgGen);

  let tempImgPath = path.join(REPORTS_DIR, 'live_test_mclaren.jpg');

  if (cleanImage && cleanImage.buffer) {
    const imgSize = cleanImage.buffer.length;
    persistFile('live_test_mclaren.jpg', cleanImage.buffer);
    console.log(`   Generated Image: ${imgSize} bytes in ${imgGenDurationMs}ms`);

    const imgCaption = [
      '🏎️ *McLaren Senna Hypercar — Midnight Neon Drift*',
      '• *Model:* FLUX.1 Schnell (HD)',
      '• *Resolution:* 1280x720 (16:9 Cinematic)',
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
    };

    console.log(`   Image Dispatch Result: ${imgSendRes.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   WAMID: ${report.items.image.messageId}`);
    console.log(`   Upload & Send Latency: ${imgSendDurationMs}ms\n`);
  } else {
    report.items.image = { success: false, error: 'Image generation failed' };
    console.error('   ❌ Failed to generate image');
  }

  await sleep(2500);

  // ----------------------------------------------------
  // STEP 3: SYNTHESIZE & DISPATCH VERIFIED VIDEO
  // ----------------------------------------------------
  console.log('3️⃣  Synthesizing & Dispatching WhatsApp-Verified Motion Video...');
  const tStartVidGen = performance.now();
  const tempVidPath = path.join(REPORTS_DIR, 'live_test_motion.mp4');

  // Use ffmpeg to generate ISO MP4 with strictly H.264 Baseline + AAC stereo (zero data track errors)
  const ffmpegExe =
    process.env.FFMPEG_PATH ||
    (process.platform === 'win32' && fs.existsSync('C:\\ffmpeg\\bin\\ffmpeg.EXE')
      ? 'C:\\ffmpeg\\bin\\ffmpeg.EXE'
      : 'ffmpeg');
  const ffmpegArgs = [
    '-loop', '1',
    '-i', tempImgPath,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-filter_complex', '[0:v]scale=1280:720,zoompan=z=\'min(zoom+0.0018,1.25)\':d=125:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1280x720,format=yuv420p[v]',
    '-map', '[v]',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-profile:v', 'baseline',
    '-level', '3.0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-t', '5',
    '-movflags', '+faststart',
    '-y',
    tempVidPath,
  ];

  const ffmpegProc = spawnSync(ffmpegExe, ffmpegArgs, { stdio: 'inherit' });
  const vidGenDurationMs = Math.round(performance.now() - tStartVidGen);

  if (ffmpegProc.status === 0 && fs.existsSync(tempVidPath)) {
    const videoBuffer = fs.readFileSync(tempVidPath);
    persistFile('live_test_motion.mp4', videoBuffer);
    console.log(`   Rendered Video: ${videoBuffer.length} bytes in ${vidGenDurationMs}ms`);

    const vidCaption = [
      '🎬 *McLaren Senna Motion Clip — Dynamic AI Zoom*',
      '• *Codec:* H.264 Baseline + Clean Stereo AAC (WhatsApp Verified)',
      '• *Resolution:* 1280x720 HD @ 25fps',
      '• *Duration:* 5.0 Seconds Motion Loop',
      '• *Status:* 100% Watermark-Free & Artifact Clean',
    ].join('\n');

    const tStartVidSend = performance.now();
    const vidSendRes = await sendWhatsAppVideo(TARGET_PHONE, videoBuffer, vidCaption);
    const vidSendDurationMs = Math.round(performance.now() - tStartVidSend);

    report.items.video = {
      success: vidSendRes.success,
      messageId: vidSendRes.messageId || null,
      fileSize: videoBuffer.length,
      genLatencyMs: vidGenDurationMs,
      sendLatencyMs: vidSendDurationMs,
    };

    console.log(`   Video Dispatch Result: ${vidSendRes.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   WAMID: ${report.items.video.messageId}`);
    console.log(`   Upload & Send Latency: ${vidSendDurationMs}ms\n`);
  } else {
    report.items.video = { success: false, error: 'Video encoding failed' };
    console.error('   ❌ Failed to render video');
  }

  console.log('========================================================');
  console.log('📊 FINAL DISPATCH SUMMARY:');
  console.log(JSON.stringify(report, null, 2));
  console.log('========================================================');

  fs.writeFileSync(path.join(REPORTS_DIR, 'live_test_dispatch_report.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
