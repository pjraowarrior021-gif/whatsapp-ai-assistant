/**
 * WhatsApp group/user identifier helpers.
 *
 * Group IDs are the single source of truth for activation. Display names are
 * never used for any permission or routing decision.
 *
 * Cloud API groups use opaque, case-sensitive identifiers (base64url-ish), not
 * phone-number JIDs. They are encoded into a canonical `cloud_<hex>@g.us` value
 * so that every existing rule (activation, isolation, persistence, dashboard)
 * keeps working with one identifier format, while remaining impossible to
 * confuse with a personal `@g.us` group id (those start with a digit).
 */

const GROUP_SUFFIX = '@g.us';
const USER_SUFFIX = '@s.whatsapp.net';
const CLOUD_RAW_PREFIX = 'cloud:';
const CLOUD_JID_PREFIX = 'cloud_';
const CLOUD_ID_PATTERN = /^[A-Za-z0-9_-]{8,400}$/;
const CLOUD_JID_BODY_PATTERN = /^cloud_[0-9a-f]{16,800}$/;

/**
 * Normalizes a group identifier into a canonical `<id>@g.us` value.
 * Accepts raw group ids, full JIDs, and Cloud API group ids (`cloud:<id>`).
 * Returns null for invalid input — callers must treat null as "reject".
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeGroupJid(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Cloud identifiers are case-sensitive, so encode them before lowercasing.
  if (raw.toLowerCase().startsWith(CLOUD_RAW_PREFIX)) {
    return cloudGroupIdToJid(raw.slice(CLOUD_RAW_PREFIX.length));
  }

  let value = raw.toLowerCase();

  // Strip a device suffix if one was supplied (e.g. 123@g.us.0).
  value = value.replace(/\.\d+$/, '');

  if (value.endsWith(GROUP_SUFFIX)) {
    const body = value.slice(0, -GROUP_SUFFIX.length);
    if (CLOUD_JID_BODY_PATTERN.test(body)) return `${body}${GROUP_SUFFIX}`;
    value = body;
  } else if (value.includes('@')) {
    // Reject user JIDs, broadcast lists and anything not a group.
    return null;
  } else if (value.startsWith(CLOUD_JID_PREFIX) && CLOUD_JID_BODY_PATTERN.test(value)) {
    return `${value}${GROUP_SUFFIX}`;
  }

  // Personal group ids use digits and hyphens. Allow a conservative character
  // set only; first character must be a digit so raw identifiers can never be
  // mistaken for an encoded Cloud group.
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
 * Encodes a Cloud API group id into the canonical group JID used everywhere
 * else in the pipeline. Returns null when the id is not a plausible Cloud id.
 * @param {string} groupId
 * @returns {string|null}
 */
export function cloudGroupIdToJid(groupId) {
  if (groupId === null || groupId === undefined) return null;
  let id = String(groupId).trim();
  if (!id) return null;
  if (id.toLowerCase().startsWith(CLOUD_RAW_PREFIX)) id = id.slice(CLOUD_RAW_PREFIX.length);
  if (id.endsWith(GROUP_SUFFIX)) id = id.slice(0, -GROUP_SUFFIX.length);
  if (id.startsWith(CLOUD_JID_PREFIX) && CLOUD_JID_BODY_PATTERN.test(id)) return `${id}${GROUP_SUFFIX}`;
  if (!CLOUD_ID_PATTERN.test(id)) return null;
  const hex = Buffer.from(id, 'utf-8').toString('hex');
  return `${CLOUD_JID_PREFIX}${hex}${GROUP_SUFFIX}`;
}

/**
 * Decodes a canonical Cloud group JID back into the id expected by Graph API.
 * Returns '' for personal groups or invalid input.
 * @param {string} input
 * @returns {string}
 */
export function jidToCloudGroupId(input) {
  const jid = normalizeGroupJid(input);
  if (!jid || !isCloudGroupJid(jid)) return '';
  const body = jid.slice(0, -GROUP_SUFFIX.length);
  return Buffer.from(body.slice(CLOUD_JID_PREFIX.length), 'hex').toString('utf-8');
}

/**
 * @param {string} input
 * @returns {boolean}
 */
export function isCloudGroupJid(input) {
  const value = String(input || '')
    .trim()
    .toLowerCase();
  if (!value.endsWith(GROUP_SUFFIX)) return false;
  return CLOUD_JID_BODY_PATTERN.test(value.slice(0, -GROUP_SUFFIX.length));
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

export { GROUP_SUFFIX, USER_SUFFIX, CLOUD_RAW_PREFIX, CLOUD_JID_PREFIX };
