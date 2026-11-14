/**
 * WhatsApp Mobile Formatting & LaTeX Normalization Engine
 *
 * Converts Markdown tables into mobile-friendly card blocks, replaces LaTeX math
 * with readable Unicode symbols, standardizes headers and bullet lists for WhatsApp,
 * repairs broken/unmatched bold asterisks, and guarantees clean spacing gaps
 * between summarization sections.
 */

const SUB_MAP = {
  0: '₀',
  1: '₁',
  2: '₂',
  3: '₃',
  4: '₄',
  5: '₅',
  6: '₆',
  7: '₇',
  8: '₈',
  9: '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

const SUP_MAP = {
  0: '⁰',
  1: '¹',
  2: '²',
  3: '³',
  4: '⁴',
  5: '⁵',
  6: '⁶',
  7: '⁷',
  8: '⁸',
  9: '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};

const GREEK_MATH_SYMBOLS = {
  '\\pm': '±',
  '\\mp': '∓',
  '\\times': '×',
  '\\div': '÷',
  '\\cdot': '·',
  '\\approx': '≈',
  '\\simeq': '≃',
  '\\sim': '~',
  '\\neq': '≠',
  '\\ne': '≠',
  '\\leq': '≤',
  '\\le': '≤',
  '\\geq': '≥',
  '\\ge': '≥',
  '\\infty': '∞',
  '^{\\circ}': '°',
  '^\\circ': '°',
  '\\circ': '°',
  '\\degree': '°',
  '\\to': '→',
  '\\rightarrow': '→',
  '\\leftarrow': '←',
  '\\Delta': 'Δ',
  '\\Omega': 'Ω',
  '\\Theta': 'Θ',
  '\\Lambda': 'Λ',
  '\\Sigma': 'Σ',
  '\\Pi': 'Π',
  '\\mu': 'μ',
  '\\lambda': 'λ',
  '\\pi': 'π',
  '\\theta': 'θ',
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\sigma': 'σ',
  '\\omega': 'ω',
  '\\phi': 'φ',
  '\\epsilon': 'ε',
  '\\chi': 'χ',
  '\\rho': 'ρ',
  '\\tau': 'τ',
  '\\eta': 'η',
  '\\kappa': 'κ',
  '\\zeta': 'ζ',
  '\\psi': 'ψ',
  '\\hbar': 'ħ',
  '\\nabla': '∇',
  '\\partial': '∂',
  '\\forall': '∀',
  '\\exists': '∃',
  '\\in': '∈',
  '\\notin': '∉',
};

/**
 * Transforms an isolated LaTeX math expression into clean Unicode.
 * @param {string} expr
 * @returns {string}
 */
function transformLatexExpr(expr) {
  let clean = expr;

  // 1. Repeatedly unwrap nested \text{...}, \mathrm{...}, \mathbf{...}, \mathit{...}
  while (/\\(?:text|mathrm|mathbf|mathit)\{([^}]+)\}/.test(clean)) {
    clean = clean.replace(/\\(?:text|mathrm|mathbf|mathit)\{([^}]+)\}/g, '$1');
  }

  // 2. Map standard Greek and math operator symbols
  for (const [symbol, replacement] of Object.entries(GREEK_MATH_SYMBOLS)) {
    clean = clean.split(symbol).join(replacement);
  }

  // 3. Fractions \frac{a}{b} -> (a/b)
  clean = clean.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1/$2)');

  // 4. Square roots \sqrt{x} -> √(x)
  clean = clean.replace(/\\sqrt\{([^}]+)\}/g, '√($1)');
  clean = clean.replace(/\\sqrt/g, '√');

  // 5. Subscripts _{...} or _char
  clean = clean.replace(/_\{([^}]+)\}/g, (_, sub) => {
    return Array.from(sub)
      .map((c) => SUB_MAP[c] || c)
      .join('');
  });
  clean = clean.replace(/_([0-9a-zA-Z+-])/g, (_, sub) => SUB_MAP[sub] || sub);

  // 6. Superscripts ^{...} or ^char
  clean = clean.replace(/\^\{([^}]+)\}/g, (_, sup) => {
    return Array.from(sup)
      .map((c) => SUP_MAP[c] || c)
      .join('');
  });
  clean = clean.replace(/\^([0-9a-zA-Z+-])/g, (_, sup) => SUP_MAP[sup] || sup);

  // 7. Strip leftover command backslashes (e.g. \text -> text)
  clean = clean.replace(/\\([a-zA-Z]+)/g, '$1');

  return clean.trim();
}

/**
 * Converts LaTeX math expressions, chemical notation, and special symbols into readable Unicode strings,
 * without corrupting standard currency symbols ($50, $100).
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeLatex(text) {
  if (!text || typeof text !== 'string') return text || '';

  // 1. Process double-dollar display math: $$...$$
  let cleaned = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => transformLatexExpr(expr));

  // 2. Process single-dollar inline math: $...$
  // Boundaries must be non-whitespace to avoid matching "$50 or $100".
  cleaned = cleaned.replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (match, expr) => {
    // If it looks purely like a price/currency ($50, $100.00, $5k, $10M), do not touch
    if (/^\d+(?:[.,]\d+)?(?:\s?[kKmMbB])?$/.test(expr)) {
      return match;
    }

    // Check if it has LaTeX features (\, _, ^, {, }, =, or recognized math symbols)
    const hasLatexFeatures = /[\\_^{}=±≈≠≤≥×÷·→←ΔΩμλπθαβγσωφε°]/.test(expr);
    const isVariableOrFormula = /^[a-zA-Z][0-9a-zA-Z_^{}+\-*\/()=]*$/.test(expr);

    if (hasLatexFeatures || isVariableOrFormula) {
      return transformLatexExpr(expr);
    }

    return match;
  });

  // 3. Process naked LaTeX commands anywhere in text (e.g. \chi, \pi, \approx, \text{...})
  while (/\\(?:text|mathrm|mathbf|mathit)\{([^}]+)\}/.test(cleaned)) {
    cleaned = cleaned.replace(/\\(?:text|mathrm|mathbf|mathit)\{([^}]+)\}/g, '$1');
  }

  for (const [symbol, replacement] of Object.entries(GREEK_MATH_SYMBOLS)) {
    if (cleaned.includes(symbol)) {
      cleaned = cleaned.split(symbol).join(replacement);
    }
  }

  // 4. Transform naked exponents and superscripts: e.g. 10^-14 -> 10⁻¹⁴, (T/Tc)^2 -> (T/Tc)², x^2 -> x²
  cleaned = cleaned.replace(/([0-9a-zA-Z)]+)\^([+-]?[0-9]+)\b/g, (_, base, exp) => {
    const sup = Array.from(exp)
      .map((c) => SUP_MAP[c] || c)
      .join('');
    return `${base}${sup}`;
  });

  // 5. Transform naked chemical and variable subscripts: e.g. H_{c1} -> Hc₁, H_{c2} -> Hc₂, H_c -> Hc, H_0 -> H₀
  cleaned = cleaned.replace(/_\{([^}]+)\}/g, (_, sub) => {
    return Array.from(sub)
      .map((c) => SUB_MAP[c] || c)
      .join('');
  });
  cleaned = cleaned.replace(/\b([A-Za-z]+)_([0-9a-zA-Z])\b/g, (_, base, sub) => {
    return `${base}${SUB_MAP[sub] || sub}`;
  });

  // 6. Clean stray backslashes before recognized or remaining LaTeX command words
  cleaned = cleaned.replace(/\\([a-zA-Z]+)/g, '$1');

  return cleaned;
}

/**
 * Converts Markdown headers (#, ##, ###) into clean WhatsApp bold headers (*Title*)
 * with guaranteed blank line gap spacing before each header.
 *
 * @param {string} text
 * @returns {string}
 */
export function convertMarkdownHeaders(text) {
  if (!text || typeof text !== 'string') return text || '';

  // Matches # Header or ### *Header* at line start
  return text.replace(/^[ \t]*#{1,6}[ \t]+(?:\*+)?(.*?)(?:\*+)?[ \t]*$/gm, (_m, title) => {
    const cleanTitle = title.trim().replace(/^\*+|\*+$/g, '');
    return `\n\n*${cleanTitle}*`;
  });
}

/**
 * Converts Markdown bullet lists (* item, - item, + item) to clean Unicode bullets (• item).
 * Also preserves indentation for nested sub-bullets (e.g. "  • item").
 *
 * @param {string} text
 * @returns {string}
 */
export function convertMarkdownBullets(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(/^([ \t]*)[*+-][ \t]+/gm, '$1• ');
}

/**
 * Cleans dangling or unclosed asterisks on lines with odd asterisk counts,
 * ensuring valid bold pairs (*word*) remain fully functional in WhatsApp.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanUnmatchedAsterisks(text) {
  return text
    .split('\n')
    .map((line) => {
      const count = (line.match(/\*/g) || []).length;
      if (count % 2 === 0) return line;

      // Find and temporarily protect properly closed bold pairs: *(not space)...(not space)*
      const pairs = [];
      const masked = line.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, (match) => {
        pairs.push(match);
        return `__VALID_BOLD_${pairs.length - 1}__`;
      });

      // Any remaining '*' is an unmatched/stray asterisk - remove it cleanly
      const cleanedMasked = masked.replace(/\*/g, '');

      // Restore valid bold pairs
      return cleanedMasked.replace(/__VALID_BOLD_(\d+)__/g, (_, idx) => pairs[Number(idx)]);
    })
    .join('\n');
}

/**
 * Converts Markdown bold markers to WhatsApp single-asterisk bold (*text*),
 * repairs double asterisks (**text**), and removes dangling asterisks.
 *
 * @param {string} text
 * @returns {string}
 */
export function convertMarkdownBold(text) {
  if (!text || typeof text !== 'string') return text || '';

  // Convert triple asterisks ***bold italic*** -> *_bold italic_*
  let res = text.replace(/\*{3,}([^*]+)\*{3,}/g, '*_$1_*');

  // Convert markdown double asterisks **bold** -> *bold*
  res = res.replace(/\*{2,}([^*]+)\*{2,}/g, '*$1*');

  // Repair any lingering unclosed double-asterisks
  res = res.replace(/\*\*/g, '*');

  // Clean unclosed/dangling asterisks that break WhatsApp bold rendering
  return cleanUnmatchedAsterisks(res);
}

/**
 * Converts Markdown tables into clean, mobile-optimized WhatsApp list blocks.
 * @param {string} text
 * @returns {string}
 */
export function convertMarkdownTables(text) {
  if (!text || !text.includes('|')) return text;

  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check if line looks like a markdown table row (starts and ends with |)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i].trim());
        i++;
      }

      // Must have header, separator line, and at least one data row
      const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
      if (tableLines.length >= 3 && isSep(tableLines[1])) {
        const parseRow = (row) =>
          row
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim());

        const headers = parseRow(tableLines[0]);
        const dataRows = tableLines
          .slice(2)
          .filter((r) => !isSep(r))
          .map(parseRow);
        const formattedBlocks = [];

        if (headers.length === 2) {
          // 2-column key/value table
          for (const row of dataRows) {
            const label = (row[0] || '').replace(/^\*+|\*+$/g, '').trim();
            const val = row[1] || '';
            if (label || val) {
              formattedBlocks.push(`• *${label}:* ${val}`);
            }
          }
        } else if (headers.length > 2) {
          // Multi-column comparison table
          for (const row of dataRows) {
            const featureName = (row[0] || '').replace(/^\*+|\*+$/g, '').trim();
            const subItems = [];
            for (let c = 1; c < headers.length; c++) {
              const headerTitle = headers[c] || `Option ${c}`;
              const cellValue = row[c] || '-';
              subItems.push(`  • *${headerTitle}:* ${cellValue}`);
            }
            if (featureName) {
              formattedBlocks.push(`*${featureName}:*\n${subItems.join('\n')}`);
            } else {
              formattedBlocks.push(subItems.join('\n'));
            }
          }
        } else {
          // Single-column list
          for (const row of dataRows) {
            if (row[0]) formattedBlocks.push(`• ${row[0]}`);
          }
        }

        result.push(formattedBlocks.join('\n\n'));
      } else {
        result.push(tableLines.join('\n'));
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

/**
 * Normalizes paragraph and section spacing so that:
 * 1. There is always a clean blank line gap (\n\n) between summary sections and headers.
 * 2. Trailing spaces on each line are stripped.
 * 3. Excessive gaps of 3 or more consecutive newlines are collapsed to a neat double newline.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSectionSpacing(text) {
  if (!text || typeof text !== 'string') return text || '';
  let formatted = text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n');

  // Ensure clean double newline between headers and preceding text
  formatted = formatted.replace(/([^\n])\n(\*[A-Za-z0-9\s&,()/-]+:\*|\*[A-Za-z0-9\s&,()/-]+\*)/g, '$1\n\n$2');

  // Collapse 3+ newlines to clean double newline
  formatted = formatted.replace(/\n{3,}/g, '\n\n').trim();

  return formatted;
}

/**
 * Main WhatsApp formatting pipeline.
 * Formats Markdown tables, headers, bullets, and bold markers, sanitizes LaTeX math into
 * mobile-friendly text, and guarantees clean spacing gaps between summarization blocks
 * while preserving code blocks untouched.
 *
 * @param {string} text
 * @returns {string}
 */
export function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') return text || '';

  // 1. Protect code blocks (```...```) from formatting modifications
  const codeBlocks = [];
  const protectedText = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // 2. Convert Markdown tables to WhatsApp card sections
  let formatted = convertMarkdownTables(protectedText);

  // 3. Convert Markdown headers (### *Title* -> *Title*) with section gap
  formatted = convertMarkdownHeaders(formatted);

  // 4. Convert bullet list markers (* item -> • item)
  formatted = convertMarkdownBullets(formatted);

  // 5. Convert double-asterisk bold (**text** -> *text*) and clean unclosed asterisks
  formatted = convertMarkdownBold(formatted);

  // 6. Sanitize LaTeX math and chemical formulas into clean Unicode
  formatted = sanitizeLatex(formatted);

  // 7. Normalize section and paragraph spacing for clean gap layout
  formatted = normalizeSectionSpacing(formatted);

  // 8. Restore protected code blocks
  formatted = formatted.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)]);

  return formatted;
}
