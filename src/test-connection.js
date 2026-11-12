import { config, validateConfig, getSafeConfigSummary } from './config.js';
import { testGeminiConnection } from './gemini.js';

async function runDiagnostics() {
  console.log('\n🔍 ====================================================');
  console.log('   Personal WhatsApp AI Assistant - Preflight Checklist');
  console.log('====================================================\n');

  // 1. Validate Environment Configuration
  const validation = validateConfig();
  const summary = getSafeConfigSummary();

  console.log('📋 [1/3] Environment Configuration:');
  console.log(`   • Port: ${summary.port}`);
  console.log(`   • Environment: ${summary.environment}`);
  console.log(`   • Gemini Model: ${summary.gemini.model}`);
  console.log(`   • Gemini API Key: ${summary.gemini.apiKeyMasked}`);
  console.log(`   • WhatsApp Phone ID: ${summary.whatsapp.phoneNumberId}`);
  console.log(`   • WhatsApp Token: ${summary.whatsapp.tokenMasked}`);
  console.log(`   • Webhook Verify Token: ${summary.whatsapp.hasVerifyToken ? 'Configured ✅' : 'Missing ❌'}`);
  console.log(
    `   • Meta App Secret: ${summary.whatsapp.hasAppSecret ? 'Configured ✅' : 'Missing ⚠️ (HMAC bypassed)'}`
  );
  console.log(`   • Authorized Senders Whitelist: ${summary.privacy.authorizedNumbersCount} phone number(s)`);
  console.log(`   • In-Memory Idle Timeout: ${summary.privacy.sessionTimeoutMinutes} minutes (RAM Only)\n`);

  if (!validation.valid) {
    console.log('⚠️  Issues Detected in Configuration:');
    validation.errors.forEach((err) => console.log(`   ❌ ${err}`));
  }

  // 2. Test Google Gemini API
  console.log('🤖 [2/3] Testing Google Gemini API Connection...');
  if (!config.GEMINI_API_KEY || config.GEMINI_API_KEY.includes('YOUR_GEMINI_API_KEY')) {
    console.log('   ⚠️  Skipping Gemini live ping: Valid GEMINI_API_KEY not configured in .env yet.');
    console.log('   👉 Obtain free key from https://aistudio.google.com/apikey');
  } else {
    try {
      const geminiResult = await testGeminiConnection();
      if (geminiResult.success) {
        console.log(
          `   ✅ Gemini API Connection: OK (Model: ${geminiResult.model}, Latency: ${geminiResult.latencyMs}ms, Reply: "${geminiResult.reply}")`
        );
      } else {
        console.log(
          `   ❌ Gemini API Ping Failed: ${geminiResult.error || 'Empty response'} (${geminiResult.latencyMs}ms)`
        );
      }
    } catch (err) {
      console.log(`   ❌ Gemini Connection Error: ${err.message}`);
    }
  }

  // 3. Test WhatsApp Cloud API Credentials
  console.log('\n💬 [3/3] Testing WhatsApp Cloud API Token & Phone ID...');
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || config.WHATSAPP_TOKEN.includes('YOUR_META')) {
    console.log('   ⚠️  Skipping WhatsApp Graph API ping: WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not configured.');
    console.log('   👉 Configure them from Meta for Developers -> WhatsApp -> API Setup.');
  } else if (config.WHATSAPP_PHONE_NUMBER_ID === '123456789012345') {
    console.log('   ❌ WHATSAPP_PHONE_NUMBER_ID is still the placeholder "123456789012345".');
    console.log('   👉 In your Meta Developer Dashboard:');
    console.log('      Navigate to: WhatsApp -> API Setup');
    console.log('      Under "Step 1: Select phone numbers", find:');
    console.log('      "Phone number ID" (a ~15 digit number)');
    console.log('      Replace 123456789012345 in .env with that number!');
  } else {
    try {
      const endpoint = `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}`;
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` },
      });
      const data = await res.json();
      if (res.ok) {
        console.log(
          `   ✅ WhatsApp API Token Verified: Connected to ${data.verified_name || data.display_phone_number || 'Phone ID'}`
        );
      } else {
        console.log(`   ❌ WhatsApp Graph API check failed: [${data?.error?.code}] ${data?.error?.message}`);
      }
    } catch (err) {
      console.log(`   ❌ WhatsApp Network Error: ${err.message}`);
    }
  }

  console.log('\n====================================================\n');
}

runDiagnostics().catch(console.error);
