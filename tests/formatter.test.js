import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForWhatsApp, convertMarkdownTables, sanitizeLatex } from '../src/formatter.js';
import { sendWhatsAppMessage } from '../src/whatsapp.js';

test('Formatter: converts multi-column markdown table into structured WhatsApp cards', () => {
  const input = `| Feature | Type-I (Soft Superconductors) | Type-II (Hard Superconductors) |
| :--- | :--- | :--- |
| *Magnetic Field Response* | Exhibits complete Meissner effect up to a single sharp critical field ($H_c$). | Has two critical fields: lower ($H_{c1}$) and upper ($H_{c2}$). |
| *Flux Penetration* | Magnetic flux is completely excluded until $H_c$, where superconductivity is abruptly destroyed. | Magnetic flux partially penetrates the material in quantized tubes between $H_{c1}$ and $H_{c2}$ (Mixed State / Vortex state). |
| *Material Type* | Mostly pure, soft metals (e.g., Lead, Mercury, Tin). | Mostly complex alloys and compounds (e.g., Niobium-titanium, $\\text{YBa}_2\\text{Cu}_3\\text{O}_7$). |
| *Applications* | Limited practical use due to low critical fields. | Extensively used for high-field electromagnets and MRI machines because of high $H_{c2}$ values. |`;

  const output = formatForWhatsApp(input);

  // Markdown table pipe separators should be completely eliminated
  assert.strictEqual(output.includes('|'), false);

  // Headers and features should be properly structured
  assert.ok(output.includes('*Magnetic Field Response:*'));
  assert.ok(output.includes('• *Type-I (Soft Superconductors):*'));
  assert.ok(output.includes('• *Type-II (Hard Superconductors):*'));

  // LaTeX math should be transformed to clean Unicode
  assert.strictEqual(output.includes('$'), false);
  assert.ok(output.includes('critical field (Hc)'));
  assert.ok(output.includes('lower (Hc₁)'));
  assert.ok(output.includes('upper (Hc₂)'));
  assert.ok(output.includes('YBa₂Cu₃O₇'));
});

test('Formatter: converts 2-column key-value markdown tables', () => {
  const input = `| Parameter | Value |
| --- | --- |
| Operating Temperature | 77 Kelvin |
| Critical Current | 100 Amperes |`;

  const output = formatForWhatsApp(input);
  assert.strictEqual(output.includes('|'), false);
  assert.ok(output.includes('• *Operating Temperature:* 77 Kelvin'));
  assert.ok(output.includes('• *Critical Current:* 100 Amperes'));
});

test('Formatter: sanitizes LaTeX math and chemical formulas to Unicode', () => {
  assert.strictEqual(sanitizeLatex('Water molecule: $\\text{H}_2\\text{O}$'), 'Water molecule: H₂O');
  assert.strictEqual(sanitizeLatex('Einstein equation: $E = mc^2$'), 'Einstein equation: E = mc²');
  assert.strictEqual(sanitizeLatex('Range: $T \\le 100^\\circ\\text{C}$'), 'Range: T ≤ 100°C');
  assert.strictEqual(sanitizeLatex('Error margin: $\\pm 0.05$'), 'Error margin: ± 0.05');
  assert.strictEqual(sanitizeLatex('Hypotenuse: $c = \\sqrt{a^2 + b^2}$'), 'Hypotenuse: c = √(a² + b²)');
  assert.strictEqual(sanitizeLatex('Ratio: $\\frac{1}{2}$'), 'Ratio: (1/2)');
  assert.strictEqual(sanitizeLatex('Limits: $0 < \\lambda < \\infty$'), 'Limits: 0 < λ < ∞');
});

test('Formatter: preserves code blocks without modifying inner syntax', () => {
  const input = `Check this JavaScript code:
\`\`\`javascript
const bitwise = a | b;
const price = "$100";
const formula = "H_2O";
\`\`\`
And here is math: $x^2 + y^2 = z^2$`;

  const output = formatForWhatsApp(input);
  assert.ok(output.includes('const bitwise = a | b;'));
  assert.ok(output.includes('const price = "$100";'));
  assert.ok(output.includes('const formula = "H_2O";'));
  assert.ok(output.includes('x² + y² = z²'));
});

test('Formatter: leaves standard currency symbols untouched', () => {
  const input = 'The monthly subscription costs $50 or $100 depending on the plan.';
  const output = formatForWhatsApp(input);
  assert.strictEqual(output, input);
});

test('Formatter: handles empty, null, or non-string inputs safely', () => {
  assert.strictEqual(formatForWhatsApp(''), '');
  assert.strictEqual(formatForWhatsApp(null), '');
  assert.strictEqual(formatForWhatsApp(undefined), '');
  assert.strictEqual(convertMarkdownTables(''), '');
  assert.strictEqual(sanitizeLatex(''), '');
});

test('Formatter: sendWhatsAppMessage automatically formats outbound messages', async () => {
  const rawMsg = '| Item | Price |\n| --- | --- |\n| Coffee | $5 |\nFormula: $E=mc^2$';
  const res = await sendWhatsAppMessage('910000000000', rawMsg);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.chunksSent, 1);
});
