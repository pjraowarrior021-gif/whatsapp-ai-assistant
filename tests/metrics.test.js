import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordMessageMetric,
  recordGeminiMetric,
  recordErrorMetric,
  recordMediaBytes,
  getPrometheusMetrics,
  resetMetrics,
} from '../src/metrics.js';

test('Metrics: Prometheus exposition includes standard metric names and counters', () => {
  resetMetrics();

  recordMessageMetric('text', 'success');
  recordMessageMetric('image', 'success');
  recordMessageMetric('voice', 'rejected');

  recordGeminiMetric('gemini-3.5-flash-lite', 'success');
  recordErrorMetric('rate_limit');
  recordMediaBytes(1048576);

  const output = getPrometheusMetrics();

  assert.ok(typeof output === 'string');
  assert.ok(output.includes('whatsapp_bot_uptime_seconds'));
  assert.ok(output.includes('whatsapp_bot_active_sessions'));
  assert.ok(output.includes('whatsapp_bot_media_bytes_total 1048576'));
  assert.ok(output.includes('whatsapp_bot_messages_total{type="text",result="success"} 1'));
  assert.ok(output.includes('whatsapp_bot_messages_total{type="image",result="success"} 1'));
  assert.ok(output.includes('whatsapp_bot_gemini_requests_total{model="gemini-3.5-flash-lite",result="success"} 1'));
  assert.ok(output.includes('whatsapp_bot_errors_total{kind="rate_limit"} 1'));

  resetMetrics();
});
