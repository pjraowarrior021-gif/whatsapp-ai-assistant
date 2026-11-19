/**
 * Deterministic, explainable moderation signals.
 *
 * The detector never performs an action. It returns findings; the moderation
 * agent decides whether an action is permitted and whether a human must
 * approve it.
 */

const SHORTENERS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'is.gd',
  'buff.ly',
  'ow.ly',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'rb.gy',
  'tiny.cc',
  'adf.ly',
  'bit.do',
  's.id',
  'v.gd',
  'clck.ru',
  'u.to',
  'qps.ru',
  'anon.to',
  'shorte.st',
  'bc.vc',
]);

const RISKY_TLDS = new Set([
  'zip',
  'mov',
  'top',
  'xyz',
  'click',
  'link',
  'work',
  'gq',
  'tk',
  'ml',
  'cf',
  'ga',
  'buzz',
  'rest',
  'fit',
  'cam',
  'icu',
  'vip',
  'loan',
  'win',
  'review',
  'country',
  'stream',
  'download',
  'racing',
  'party',
  'science',
  'date',
  'faith',
  'accountant',
  'men',
  'cricket',
  'trade',
  'webcam',
  'bid',
  'mom',
  'lol',
  'autos',
  'boats',
  'homes',
  'motorcycles',
  'yachts',
  'sbs',
  'cfd',
  'quest',
  'buzz',
  'monster',
  'cyou',
]);

const SCAM_PATTERNS = [
  /\bverify (your|the) account\b/i,
  /\baccount (will be|has been) (blocked|suspended|limited)\b/i,
  /\bcomplete (your )?kyc\b/i,
  /\bkyc (update|verification|pending)\b/i,
  /\byou (have )?won\b/i,
  /\blottery|jackpot|prize money|lucky (winner|draw)\b/i,
  /\bclick (here|this link) (to|and) (claim|verify|receive|win)\b/i,
  /\bfree (recharge|data|gift|iphone|crypto)\b/i,
  /\bdouble your (money|investment|crypto)\b/i,
  /\bguaranteed (returns|profit|income)\b/i,
  /\b(work from home|part[- ]time job).{0,40}\b(earn|income|salary)\b/i,
  /\bregistration fee|processing fee|joining fee|security deposit\b/i,
  /\bsend (your )?(otp|pin|password|card (number|details))\b/i,
  /\bshare (your )?(otp|pin|password|bank details|upi)\b/i,
  /\b(loan|credit card) (approved|pre[- ]approved)\b/i,
  /\bcustoms (fee|clearance|department)\b/i,
  /\bparcel (is )?(held|stuck|pending)\b/i,
  /\btelegram.{0,30}\b(investment|trading|signal|profit)\b/i,
  /\b(crypto|usdt|bitcoin).{0,30}\b(giveaway|airdrop|double|profit)\b/i,
];

const URGENCY_PATTERNS = [
  /\burgent\b/i,
  /\bimmediately\b/i,
  /\bwithin \d+ (hours|minutes)\b/i,
  /\blast chance\b/i,
  /\bexpires? (today|soon)\b/i,
  /\bonly \d+ (left|spots?)\b/i,
];

const MONEY_PATTERNS = [
  /\b₹\s?\d+/,
  /\bRs\.?\s?\d+/i,
  /\$\s?\d+/,
  /\bupi\b/i,
  /\bpayment\b/i,
  /\btransfer\b/i,
  /\brefund\b/i,
];

const IMPERSONATION_BRANDS = [
  'whatsapp',
  'whatsappbusiness',
  'telegram',
  'instagram',
  'facebook',
  'paytm',
  'phonepe',
  'googlepay',
  'amazon',
  'flipkart',
  'netflix',
  'sbi',
  'hdfc',
  'icici',
  'axisbank',
  'kotak',
  'paypal',
];

export const SEVERITY = Object.freeze({
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

/**
 * Tracks repeated identical/near-identical messages per group+sender.
 */
export class SpamTracker {
  constructor({ maxSenders = 5000 } = {}) {
    this.events = new Map(); // `${jid}|${sender}` -> [{hash, at}]
    this.maxSenders = maxSenders;
  }

  /**
   * @param {{ groupJid: string, senderJid: string, text: string, now?: number, windowMs?: number }} input
   * @returns {number} occurrences including this one
   */
  observe({ groupJid, senderJid, text, now = Date.now(), windowMs = 600000 }) {
    const key = `${groupJid}|${senderJid}`;
    const hash = normalize(text);
    if (!hash) return 1;
    const list = (this.events.get(key) || []).filter((e) => now - e.at <= windowMs);
    list.push({ hash, at: now });
    this.events.set(key, list);
    if (this.events.size > this.maxSenders) {
      const oldest = this.events.keys().next().value;
      this.events.delete(oldest);
    }
    return list.filter((e) => e.hash === hash).length;
  }

  reset() {
    this.events.clear();
  }
}

/**
 * @param {{ text: string, settings: object, spamCount?: number, mentionCount?: number }} input
 * @returns {{ severity: string, categories: string[], reasons: string[], requiresHuman: boolean, suggestedAction: string }}
 */
export function analyzeMessage({ text = '', settings = {}, spamCount = 1, mentionCount = 0 } = {}) {
  const moderation = settings.moderation || {};
  const categories = [];
  const reasons = [];
  let severity = SEVERITY.NONE;

  const raise = (level, category, reason) => {
    categories.push(category);
    reasons.push(reason);
    if (rank(level) > rank(severity)) severity = level;
  };

  if (moderation.enabled === false) {
    return { severity: SEVERITY.NONE, categories: [], reasons: [], requiresHuman: false, suggestedAction: 'none' };
  }

  const content = String(text || '');
  const lower = content.toLowerCase();
  const urls = extractUrls(content);

  if (moderation.suspiciousLinks !== false && urls.length > 0) {
    for (const url of urls) {
      const analysis = analyzeUrl(url, moderation);
      if (analysis.suspicious) {
        raise(analysis.severity, 'suspicious_link', analysis.reason);
      }
    }
  }

  if (moderation.scamDetection !== false) {
    for (const pattern of SCAM_PATTERNS) {
      if (pattern.test(content)) {
        raise(urls.length > 0 ? SEVERITY.HIGH : SEVERITY.MEDIUM, 'scam', 'Message matches a known scam pattern');
        break;
      }
    }
    if (
      urls.length > 0 &&
      URGENCY_PATTERNS.some((p) => p.test(content)) &&
      MONEY_PATTERNS.some((p) => p.test(content))
    ) {
      raise(SEVERITY.HIGH, 'scam', 'Urgency, money and a link in one message');
    }
  }

  if (moderation.antiSpam !== false) {
    const threshold = Number(moderation.repeatedMessageThreshold) || 3;
    if (spamCount >= threshold) {
      raise(
        spamCount >= threshold + 2 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        'spam',
        `Repeated message ${spamCount} times`
      );
    }
    const maxMentions = Number(moderation.maxMentions) || 12;
    if (mentionCount >= maxMentions) {
      raise(SEVERITY.MEDIUM, 'mass_mention', `Mass mention of ${mentionCount} participants`);
    }
    if (/(https?:\/\/\S+\s*){4,}/i.test(content)) {
      raise(SEVERITY.MEDIUM, 'link_flood', 'Multiple links in one message');
    }
  }

  for (const word of moderation.bannedWords || []) {
    if (word && lower.includes(String(word).toLowerCase())) {
      raise(SEVERITY.HIGH, 'inappropriate', 'Contains a banned word or phrase');
      break;
    }
  }

  const requiresHuman = severity === SEVERITY.HIGH || categories.includes('scam');
  const suggestedAction =
    severity === SEVERITY.NONE
      ? 'none'
      : moderation.action === 'warn' && severity !== SEVERITY.HIGH
        ? 'warn'
        : 'escalate';

  return { severity, categories: dedupe(categories), reasons: dedupe(reasons), requiresHuman, suggestedAction };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const matches = String(text || '').match(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi) || [];
  return matches.map((m) => m.replace(/[.,;:!?]+$/, '')).slice(0, 20);
}

/**
 * @param {string} rawUrl
 * @param {object} moderation
 */
export function analyzeUrl(rawUrl, moderation = {}) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
  } catch {
    return { suspicious: false, severity: SEVERITY.LOW, reason: 'Malformed URL' };
  }

  const host = url.hostname.toLowerCase();
  const tld = host.split('.').pop();
  const blocked = (moderation.blockedDomains || []).some((d) => host === d || host.endsWith(`.${d}`));

  if (blocked) return { suspicious: true, severity: SEVERITY.HIGH, reason: 'Domain is on the group blocklist' };
  if (host.startsWith('xn--') || host.includes('.xn--')) {
    return { suspicious: true, severity: SEVERITY.HIGH, reason: 'Punycode domain can spoof another site' };
  }
  if (isIpHost(host)) return { suspicious: true, severity: SEVERITY.HIGH, reason: 'Direct IP address link' };
  if (looksLikeBrandImpersonation(host)) {
    return { suspicious: true, severity: SEVERITY.HIGH, reason: 'Lookalike domain impersonates a known brand' };
  }
  if (url.username || url.password) {
    return { suspicious: true, severity: SEVERITY.HIGH, reason: 'Credential-like userinfo in URL' };
  }
  if (SHORTENERS.has(host)) {
    return { suspicious: true, severity: SEVERITY.MEDIUM, reason: 'Link shortener hides the destination' };
  }
  if (RISKY_TLDS.has(tld)) {
    return { suspicious: true, severity: SEVERITY.MEDIUM, reason: `Risky top-level domain .${tld}` };
  }
  return { suspicious: false, severity: SEVERITY.NONE, reason: 'No link signal' };
}

function isIpHost(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes('[') || /^0x[0-9a-f]+$/i.test(host);
}

function looksLikeBrandImpersonation(host) {
  const labels = host.split('.');
  const registrable = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  for (const brand of IMPERSONATION_BRANDS) {
    if (registrable === brand) return false; // genuine domain (best effort)
    if (registrable.includes(brand) && registrable !== brand) {
      const extra = registrable.replace(brand, '').replace(/[^a-z]/g, '');
      if (extra.length > 0) return true;
    }
  }
  return false;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function rank(level) {
  return { none: 0, low: 1, medium: 2, high: 3 }[level] ?? 0;
}

function dedupe(arr) {
  return [...new Set(arr)];
}
