// Core primitives shared by the SDK and the Authority: licence numbers, Ed25519 keys, canonical JSON, signed tokens.
'use strict';
const crypto = require('node:crypto');

// ---------- Licence numbers: PA-XXXX-XXXX-XXXX ----------
// Crockford base-32 (no I, L, O, U: nothing to misread), 11 random characters + 1 Luhn mod-32 check character.
// The check character catches every single-character typo and most swapped neighbours.
const ID_PREFIX = 'PA';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function luhnCheckChar(body) {
  let factor = 2, sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * ALPHABET.indexOf(body[i]);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / 32) + (addend % 32);
  }
  return ALPHABET[(32 - (sum % 32)) % 32];
}
function newAgentId() {
  let body = '';
  for (let i = 0; i < 11; i++) body += ALPHABET[crypto.randomInt(32)];
  return ID_PREFIX + body + luhnCheckChar(body);
}
/** Accepts "pa-7k4m 9qx2-h3tb", O for 0, I/L for 1. Returns the canonical form (no dashes). */
const normalizeAgentId = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
function isValidAgentId(s) {
  const id = normalizeAgentId(s);
  if (!new RegExp('^' + ID_PREFIX + '[' + ALPHABET + ']{12}$').test(id)) return false;
  const body = id.slice(ID_PREFIX.length);
  return luhnCheckChar(body.slice(0, -1)) === body.slice(-1);
}
const formatAgentId = (s) => { const id = normalizeAgentId(s); return ID_PREFIX + '-' + id.slice(ID_PREFIX.length).match(/.{1,4}/g).join('-'); };

// ---------- Encoding helpers ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/** Deterministic JSON (sorted keys) so signatures and hashes are stable. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// ---------- Ed25519 ----------
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}
const importPublic = (b64) => crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
const importPrivate = (b64) => crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });

function sign(privateKeyB64, message) {
  return crypto.sign(null, Buffer.from(message), importPrivate(privateKeyB64)).toString('base64url');
}
function verify(publicKeyB64, message, signature) {
  try {
    return crypto.verify(null, Buffer.from(message), importPublic(publicKeyB64), Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
const keyFingerprint = (publicKeyB64) => sha256(Buffer.from(publicKeyB64, 'base64')).slice(0, 16);

// ---------- Compact signed tokens (standard JWT, alg EdDSA) ----------
function signToken(payload, privateKeyB64, kid, typ = 'agent-card+jwt') {
  const header = { alg: 'EdDSA', typ, kid };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
  return input + '.' + sign(privateKeyB64, input);
}
function decodeToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  return {
    header: JSON.parse(Buffer.from(parts[0], 'base64url')),
    payload: JSON.parse(Buffer.from(parts[1], 'base64url')),
    input: parts[0] + '.' + parts[1],
    signature: parts[2],
  };
}
function verifyToken(token, publicKeyB64) {
  const t = decodeToken(token);
  if (t.header.alg !== 'EdDSA') throw new Error('unsupported alg');
  if (!verify(publicKeyB64, t.input, t.signature)) throw new Error('bad signature');
  return t;
}

// ---------- Signed agent requests ----------
/** The exact string an agent signs for each API call. */
function requestSigningString({ method, path, timestamp, nonce, body }) {
  return [method.toUpperCase(), path, timestamp, nonce, sha256(body || '')].join('\n');
}

/** Wildcard scope match: "payments.*" covers "payments.transfer"; "*" covers everything. */
function scopeMatches(pattern, action) {
  if (pattern === '*' || pattern === action) return true;
  if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
  return false;
}
/** Is every child scope covered by at least one parent scope? */
const scopesSubset = (child, parent) => child.every((c) => parent.some((p) => scopeMatches(p, c.replace(/\.\*$/, '.x')) && (c !== '*' || p === '*')));

// ---------- Proof of work (makes mass self-registration expensive) ----------
function leadingZeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const n = parseInt(ch, 16);
    if (n === 0) { bits += 4; continue; }
    return bits + Math.clz32(n) - 28;
  }
  return bits;
}
const powHash = (publicKey, ts, nonce) => sha256(`${publicKey}:${ts}:${nonce}`);
const powValid = (publicKey, ts, nonce, bits) => leadingZeroBits(powHash(publicKey, ts, nonce)) >= bits;
function solvePow(publicKey, ts, bits) {
  for (let n = 0; ; n++) if (powValid(publicKey, ts, String(n), bits)) return String(n);
}

// ---------- Resource globbing: `*` = one path segment, `**` = anything ----------
const globCache = new Map();
function globMatch(pattern, value) {
  if (pattern === value || pattern === '**') return true;
  let re = globCache.get(pattern);
  if (!re) {
    // "a/**" also matches "a" itself (so a directory can be listed).
    const seg = (s) => s.split('**').map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    const src = pattern.split('/**').map(seg).join('(?:/.*)?');
    re = new RegExp('^' + src + '$');
    globCache.set(pattern, re);
  }
  return re.test(value);
}
const opMatch = (ops, op) => ops.includes('*') || ops.includes(op);

module.exports = {
  globMatch, opMatch,
  leadingZeroBits, powHash, powValid, solvePow,
  ID_PREFIX, newAgentId, normalizeAgentId, isValidAgentId, formatAgentId,
  b64u, sha256, randomToken, canonical,
  generateKeyPair, sign, verify, keyFingerprint,
  signToken, decodeToken, verifyToken,
  requestSigningString, scopeMatches, scopesSubset,
};
