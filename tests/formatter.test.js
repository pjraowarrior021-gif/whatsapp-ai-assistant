import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatForWhatsApp,
  convertMarkdownTables,
  convertMarkdownHeaders,
  convertMarkdownBullets,
  convertMarkdownBold,
  normalizeSectionSpacing,
  sanitizeLatex,
} from '../src/formatter.js';
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

test('Formatter: converts Markdown headers and creates section gap spacing', () => {
  const input =
    'Introductory summary paragraph.\n\n### *Core Concepts*\n* Details here\n\n## Classifications\n* More details';
  const output = convertMarkdownHeaders(input);
  assert.strictEqual(output.includes('###'), false);
  assert.strictEqual(output.includes('##'), false);
  assert.ok(output.includes('*Core Concepts*'));
  assert.ok(output.includes('*Classifications*'));
});

test('Formatter: converts raw asterisk bullets to clean Unicode bullets with sub-indentation', () => {
  const input = '* *Item 1:* Description\n  * *Sub-item:* Sub-description\n- *Item 2:* More info';
  const output = convertMarkdownBullets(input);
  assert.ok(output.includes('• *Item 1:* Description'));
  assert.ok(output.includes('  • *Sub-item:* Sub-description'));
  assert.ok(output.includes('• *Item 2:* More info'));
  assert.strictEqual(output.includes('* *Item 1:*'), false);
});

test('Formatter: converts double asterisks to single WhatsApp bold and fixes broken formatting', () => {
  const input = 'This is **bold** text and an **electron-phonon-electron interaction*.';
  const output = convertMarkdownBold(input);
  assert.ok(output.includes('*bold*'));
  assert.ok(output.includes('*electron-phonon-electron interaction*.'));
  assert.strictEqual(output.includes('**'), false);
});

test('Formatter: formats full superconductivity document summary with clean gaps and special chars', () => {
  const input = `This document provides a comprehensive overview of *Superconductivity*, covering its physical principles, classifications, and practical applications in modern technology.

### *Core Concepts*
* *Superconductivity:* A state where electrical resistivity drops to zero when a material is cooled below its *critical temperature (Tc)*.
* *Meissner Effect:* A defining property where a superconductor expels all internal magnetic flux lines when cooled below Tc in a weak magnetic field, behaving as a *perfect diamagnet* (magnetic susceptibility χ = -1).
* *Critical Parameters:*
  * *Critical Magnetic Field (Hc):* The field strength required to destroy the superconducting state. It follows the parabolic relation: *Hc(T) = H0 [1 - (T/Tc)²]*.
  * *Critical Current (Ic):* The maximum current a wire of radius r can carry before its self-induced magnetic field destroys superconductivity, defined by *Ic = 2πrHc*.

### *Classifications*
* *Type-I (Soft):* Exhibits a sharp transition; low Hc (< 0.1 Tesla); includes pure metals like Hg, Pb, and Sn.
* *Type-II (Hard):* Exhibits a gradual "vortex/mixed state" between two critical fields (Hc1 and Hc2); high Hc (up to 30 Tesla); includes alloys like NbTi and ceramics like YBCO.

### *Theoretical Foundations*
* *BCS Theory:* Explains superconductivity via *Cooper Pairs—electrons that form a bound state at low temperatures through an **electron-phonon-electron interaction*. These pairs act as bosons and condense into a single coherent quantum state.
* *Energy Gap (Eg):* The binding energy required to break a Cooper pair, given by *Eg(0) = 3.528 kBTc*.

### *Advanced Phenomena & Applications*
* *Josephson Junctions:* An S-I-S structure where Cooper pairs tunnel through an insulator.
  * *DC Effect:* Current flows without voltage.
  * *AC Effect:* Applying a DC voltage causes an oscillating supercurrent with a frequency *v = 2eV/h* (≃ 483.6 GHz/mV).
* *SQUID:* An ultra-sensitive magnetometer that uses Josephson junctions to measure magnetic fields as weak as 10⁻¹⁴ Tesla.
* *Maglev Vehicles:* Use superconducting magnets for levitation, guidance, and propulsion, enabling speeds exceeding 500 km/h by eliminating wheel-rail friction.
* *High-Temperature Superconductors (HTS):* Materials like *YBCO (Tc ≈ 92 K)* that allow for cooling with liquid nitrogen (77 K) rather than the more expensive liquid helium (4.2 K).`;

  const output = formatForWhatsApp(input);

  // 1. Verify no markdown headers remain
  assert.strictEqual(output.includes('###'), false);

  // 2. Verify bold headers exist
  assert.ok(output.includes('*Core Concepts*'));
  assert.ok(output.includes('*Classifications*'));
  assert.ok(output.includes('*Theoretical Foundations*'));
  assert.ok(output.includes('*Advanced Phenomena & Applications*'));

  // 3. Verify bullets are clean Unicode bullets
  assert.strictEqual(output.includes('* *Superconductivity:*'), false);
  assert.ok(output.includes('• *Superconductivity:*'));
  assert.ok(output.includes('• *Meissner Effect:*'));
  assert.ok(output.includes('  • *Critical Magnetic Field (Hc):*'));

  // 4. Verify double asterisks are resolved
  assert.strictEqual(output.includes('**'), false);
  assert.ok(output.includes('*electron-phonon-electron interaction*'));

  // 5. Verify section gaps exist (blank line between sections)
  assert.ok(output.includes('\n\n*Core Concepts*'));
  assert.ok(output.includes('\n\n*Classifications*'));
  assert.ok(output.includes('\n\n*Theoretical Foundations*'));
  assert.ok(output.includes('\n\n*Advanced Phenomena & Applications*'));
});

test('Formatter: preserves code blocks without modifying inner syntax', () => {
  const input = `Check this JavaScript code:
\`\`\`javascript
const bitwise = a | b;
const price = "$100";
const formula = "H_2O";
### Not a header
* Not a bullet
\`\`\`
And here is math: $x^2 + y^2 = z^2$`;

  const output = formatForWhatsApp(input);
  assert.ok(output.includes('const bitwise = a | b;'));
  assert.ok(output.includes('const price = "$100";'));
  assert.ok(output.includes('const formula = "H_2O";'));
  assert.ok(output.includes('### Not a header'));
  assert.ok(output.includes('* Not a bullet'));
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
  assert.strictEqual(convertMarkdownHeaders(''), '');
  assert.strictEqual(convertMarkdownBullets(''), '');
  assert.strictEqual(convertMarkdownBold(''), '');
  assert.strictEqual(normalizeSectionSpacing(''), '');
});

test('Formatter: sendWhatsAppMessage automatically formats outbound messages', async () => {
  const rawMsg = '### Summary Header\n* *Item:* Detail\nFormula: $E=mc^2$';
  const res = await sendWhatsAppMessage('910000000000', rawMsg);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.chunksSent, 1);
});
