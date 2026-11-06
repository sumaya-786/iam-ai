// For anyone who needs to TRUST an agent: banks, SaaS APIs, marketplaces, other agents.
// Verifies Pehchaan licences offline (signature + expiry) and, optionally, live (not suspended or cancelled).
'use strict';
const C = require('./core');

const DEFAULT_AUTHORITY = process.env.PEHCHAAN_AUTHORITY || 'http://localhost:7420';

class Authority {
  /**
   * @param {string} [url] the licensing authority (defaults to PEHCHAAN_AUTHORITY)
   * @param {{publicKey?: string}} [opts] pin the authority's public key to verify fully offline
   */
  constructor(url = DEFAULT_AUTHORITY, { publicKey } = {}) {
    this.url = url.replace(/\/$/, '');
    this.publicKey = publicKey || null;
  }

  async #get(path) {
    const r = await fetch(this.url + path);
    const d = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${d.error}: ${d.message}`), { code: d.error });
    return d;
  }
  /** The authority's signing key (fetched once, then cached). Pin it in production. */
  async key() {
    if (!this.publicKey) this.publicKey = (await this.#get('/v1/registry/keys')).keys[0].spki;
    return this.publicKey;
  }

  /**
   * Check a licence card an agent presents.
   * offline: signature by the authority + not expired (works with no network once the key is pinned)
   * live (default): also asks the authority whether the licence is still in good standing right now.
   */
  async verify(card, { live = true, roles = [], minTrust = 0 } = {}) {
    let t;
    try { t = C.verifyToken(card, await this.key()); } catch (e) { return { valid: false, reason: 'not_issued_by_authority' }; }
    const p = t.payload;
    if (p.exp * 1000 < Date.now()) return { valid: false, reason: 'card_expired', licence: p };
    const missing = roles.filter((r) => !p.roles.includes(r));
    if (missing.length) return { valid: false, reason: 'missing_roles:' + missing.join(','), licence: p };
    if (p.trust < minTrust) return { valid: false, reason: `trust_below_${minTrust}`, licence: p };
    if (!live) return { valid: true, mode: 'offline', licence: p };
    const v = await fetch(this.url + '/v1/cards/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card }) }).then((r) => r.json());
    return { valid: !!v.valid, reason: v.reason || null, mode: 'live', licence: p, live: v.live };
  }

  /** Public licence details by number (what the QR code opens). */
  lookup(licenceNumber) { return this.#get('/v1/licence/' + encodeURIComponent(C.normalizeAgentId(licenceNumber))); }
  /** The URL printed in a licence's QR code. */
  licenceUrl(licenceNumber) { return `${this.url}/a/${C.formatAgentId(licenceNumber)}`; }

  /**
   * Middleware for Node http / Express / Connect: only licensed agents get through.
   * Agents send their card in the `x-agent-licence` header. On success: req.agentLicence = licence payload.
   */
  requireLicence(opts = {}) {
    return async (req, res, next) => {
      const card = req.headers['x-agent-licence'];
      const result = card ? await this.verify(card, opts) : { valid: false, reason: 'no_licence_presented' };
      if (result.valid) { req.agentLicence = result.licence; return next(); }
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unlicensed_agent', reason: result.reason, authority: this.url }));
    };
  }
}

module.exports = { Authority, DEFAULT_AUTHORITY };
