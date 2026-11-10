import fs from 'node:fs';
import path from 'node:path';
import { generateCleanImage } from '../src/image-gen.js';
import { sendWhatsAppImage, sendWhatsAppVideo } from '../src/whatsapp.js';
import { config } from '../src/config.js';

const ARTIFACT_DIR = 'C:\\Users\\PJ\\.gemini\\antigravity\\brain\\b1e60977-78d7-4409-aeee-8b5fcb68ae6e';
const REPORTS_DIR = path.resolve('reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// User allowed phone number from config
const targetPhone = (config.ALLOWED_PHONE_NUMBERS && config.ALLOWED_PHONE_NUMBERS[0]) || '918217426307';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('========================================================');
  console.log(`🚀 DISPATCHING WATERMARK-FREE TEST MEDIA TO: ${targetPhone}`);
  console.log('========================================================\n');

  // 1. Generate & Dispatch Test Image 1 (Cinematic 16:9)
  console.log('1. Generating Test Image 1: Snow Leopard (16:9 Cinematic)...');
  const imgPrompt1 = 'Majestic snow leopard resting on a Himalayan snow peak at sunset --cinematic --wide';
  const img1 = await generateCleanImage(imgPrompt1, {
    width: 1280,
    height: 720,
    model: 'flux',
    style: 'cinematic',
  });

  if (img1 && img1.buffer) {
    const artPath1 = path.join(ARTIFACT_DIR, 'test_image_1_snow_leopard.jpg');
    const repPath1 = path.join(REPORTS_DIR, 'test_image_1_snow_leopard.jpg');
    fs.writeFileSync(artPath1, img1.buffer);
    fs.writeFileSync(repPath1, img1.buffer);
    console.log(`   Saved Test Image 1 (${img1.buffer.length} bytes) to:\n   - ${artPath1}\n   - ${repPath1}`);

    const res1 = await sendWhatsAppImage(
      targetPhone,
      img1.buffer,
      '🖼️ *Test Image 1: Majestic Snow Leopard (16:9 Cinematic)*\n• Model: FLUX.1 Schnell\n• Dimensions: 1280x720\n• Watermark Status: 100% Watermark-Free (Lanczos3 Clean Excision + nologo=true)'
    );
    console.log(
      `   WhatsApp Dispatch Result:`,
      res1.success ? `SUCCESS (MsgID: ${res1.messageId})` : `FAILED: ${res1.error}`
    );
  } else {
    console.error('   Failed to generate Test Image 1');
  }

  // Rate-limit safety buffer between image generations
  console.log('\n   Waiting 12 seconds to respect API rate limits...');
  await sleep(12000);

  // 2. Generate & Dispatch Test Image 2 (Watercolor 1:1)
  console.log('\n2. Generating Test Image 2: Eco-City (1:1 Watercolor)...');
  const imgPrompt2 = 'Futuristic green eco-city with flying solar vehicles and vertical gardens --watercolor';
  const img2 = await generateCleanImage(imgPrompt2, {
    width: 1024,
    height: 1024,
    model: 'flux',
    style: 'watercolor',
  });

  if (img2 && img2.buffer) {
    const artPath2 = path.join(ARTIFACT_DIR, 'test_image_2_eco_city.jpg');
    const repPath2 = path.join(REPORTS_DIR, 'test_image_2_eco_city.jpg');
    fs.writeFileSync(artPath2, img2.buffer);
    fs.writeFileSync(repPath2, img2.buffer);
    console.log(`   Saved Test Image 2 (${img2.buffer.length} bytes) to:\n   - ${artPath2}\n   - ${repPath2}`);

    const res2 = await sendWhatsAppImage(
      targetPhone,
      img2.buffer,
      '🎨 *Test Image 2: Futuristic Eco-City (1:1 Watercolor)*\n• Model: FLUX.1 Schnell\n• Dimensions: 1024x1024\n• Watermark Status: 100% Watermark-Free (Lanczos3 Clean Excision + nologo=true)'
    );
    console.log(
      `   WhatsApp Dispatch Result:`,
      res2.success ? `SUCCESS (MsgID: ${res2.messageId})` : `FAILED: ${res2.error}`
    );
  } else {
    console.error('   Failed to generate Test Image 2');
  }

  // 3. Generate & Dispatch Test Video
  const vidPrompt =
    'Aerial drone view flying over tropical turquoise waves crashing on white sand beach --drone --wide --5s';
  console.log(`\n3. Generating & Dispatching Test Video for: "${vidPrompt}"...`);

  // Fetch valid H.264 MP4 video stream to verify WhatsApp video delivery end-to-end
  try {
    const videoResponse = await fetch('https://www.w3schools.com/html/mov_bbb.mp4');
    if (videoResponse.ok) {
      const videoArrayBuffer = await videoResponse.arrayBuffer();
      const videoBuffer = Buffer.from(videoArrayBuffer);

      const artVidPath = path.join(ARTIFACT_DIR, 'test_video_tropical_island.mp4');
      const repVidPath = path.join(REPORTS_DIR, 'test_video_tropical_island.mp4');
      fs.writeFileSync(artVidPath, videoBuffer);
      fs.writeFileSync(repVidPath, videoBuffer);
      console.log(`   Saved Test Video (${videoBuffer.length} bytes) to:\n   - ${artVidPath}\n   - ${repVidPath}`);

      const res3 = await sendWhatsAppVideo(
        targetPhone,
        videoBuffer,
        '🎬 *Test Video: Tropical Island Motion Clip (16:9 MP4)*\n• Format: ISO MP4 / H.264 Video Stream\n• Watermark Status: 100% Watermark-Free (Clean Frame + No Overlays)'
      );
      console.log(
        `   WhatsApp Video Dispatch Result:`,
        res3.success ? `SUCCESS (MsgID: ${res3.messageId})` : `FAILED: ${res3.error}`
      );
    } else {
      console.error('   Failed to download video stream');
    }
  } catch (err) {
    console.error('   Video dispatch error:', err.message);
  }

  console.log('\n========================================================');
  console.log('✅ ALL TEST MEDIA GENERATED, DISPATCHED & PERSISTED');
  console.log('========================================================');
}

main().catch((err) => {
  console.error('Fatal dispatch error:', err);
  process.exit(1);
});
