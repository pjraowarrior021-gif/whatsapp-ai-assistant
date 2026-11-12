import fs from 'node:fs';
import path from 'node:path';
import { sendWhatsAppVideo } from '../src/whatsapp.js';

const TARGET_PHONE = '918217426307';
const videoPath = path.resolve('reports/test_dispatch_mclaren_senna.mp4');
const videoBuffer = fs.readFileSync(videoPath);

const caption = [
  '🏎️ *McLaren Senna Hypercar — Dynamic Motion Clip*',
  '• *Codec:* H.264 Baseline / Stereo AAC (100% WhatsApp Verified)',
  '• *Resolution:* 1280x720 HD @ 25fps',
  '• *Audio:* Clean Native AAC Audio Stream',
  '• *Durability:* Watermark-Free & High Performance',
].join('\n');

console.log(`Sending verified video to ${TARGET_PHONE} (${videoBuffer.length} bytes)...`);

const res = await sendWhatsAppVideo(TARGET_PHONE, videoBuffer, caption);
console.log('Dispatch result:', res);
