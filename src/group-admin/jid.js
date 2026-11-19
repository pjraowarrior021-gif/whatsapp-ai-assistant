/**
 * WhatsApp group/user identifier helpers.
 *
 * Group IDs are the single source of truth for activation. Display names are
 * never used for any permission or routing decision.
 */

const GROUP_SUFFIX = '@g.us';
const USER_SUFFIX = '@s.whatsapp.net';

/**
 * Normalizes a group identifier into a canonical `<id>@g.us` value.
 * Accepts raw group ids, full JIDs, and Cloud API group ids.
 * Returns null for invalid input — callers must treat null as "reject".
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeGroupJid(input) {
  if (input === null || input === undefined) return null;
  let value = String(input).trim().toLowerCase();
  if (!value) return null;

  // Strip a device suffix if one was supplied (e.g. 123@g.us.0).
  value = value.replace(/\.\d+$/, '');

  if (value.endsWith(GROUP_SUFFIX)) {
    value = value.slice(0, -GROUP_SUFFIX.length);
  } else if (value.includes('@')) {
    // Reject user JIDs, broadcast lists and anything not a group.
    return null;
  }

  // Cloud group ids use digits and hyphens; personal ids use digits/hyphens too.
  // Allow a conservative character set only.
  if (!/^[0-9][0-9a-z._-]{2,120}$/.test(value)) return null;
  return `${value}${GROUP_SUFFIX}`;
}

/**
 * @param {string} input
 * @returns {boolean}
 */
export function isValidGroupJid(input) {
  return normalizeGroupJid(input) !== null;
}

/**
 * Normalizes a sender/participant identifier for display and admin matching.
 * Only used for identity comparisons, never for group activation.
 * @param {string} input
 * @returns {string}
 */
export function normalizeUserJid(input) {
  if (!input) return '';
  let value = String(input).trim().toLowerCase();
  if (value.endsWith(USER_SUFFIX)) value = value.slice(0, -USER_SUFFIX.length);
  if (value.includes('@')) value = value.split('@')[0];
  // LID identifiers and phone numbers both reduce to digits.
  return value.replace(/\D/g, '');
}

/**
 * Extracts a phone number from a WhatsApp JID.
 * @param {string} jid
 * @returns {string}
 */
export function jidToPhone(jid) {
  return normalizeUserJid(jid);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameGroup(a, b) {
  const na = normalizeGroupJid(a);
  const nb = normalizeGroupJid(b);
  return Boolean(na && nb && na === nb);
}

/**
 * Detects whether a Cloud API `from` value is a group.
 * @param {string} from
 * @returns {boolean}
 */
export function isCloudGroupFrom(from) {
  return typeof from === 'string' && from.toLowerCase().includes(GROUP_SUFFIX);
}

export { GROUP_SUFFIX, USER_SUFFIX };
