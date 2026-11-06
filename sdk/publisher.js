// For anyone who BUILDS agents: register as a publisher, then get learner licences for your agents.
// Your publisher key signs every application, and all your agents share one reputation.
'use strict';
const fs = require('node:fs');
const C = require('./core');
const { PehchaanAgent } = require('./agent');
const { DEFAULT_AUTHORITY } = require('./authority');

class Publisher {
  constructor({ authority = DEFAULT_AUTHORITY, publicKey, privateKey, id = null, name = null, domain = null }) {
    Object.assign(this, { authority: authority.replace(/\/$/, ''), publicKey, privateKey, id, name, domain });
  }
  static create(authority) { return new Publisher({ authority, ...C.generateKeyPair() }); }
  static fromFile(file, authority) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return new Publisher({ ...j, authority: authority || j.authority }); }
  save(file) { fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2)); return file; }
  toJSON() { return { authority: this.authority, id: this.id, name: this.name, domain: this.domain, publicKey: this.publicKey, privateKey: this.privateKey }; }

  async #post(path, body) {
    const r = await fetch(this.authority + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${d.error}: ${d.message}`), { code: d.error, status: r.status, data: d });
    return d;
  }
  async #powBits() { return (await (await fetch(this.authority + '/v1/registry/policy')).json()).licensing.powBits; }

  /** Register with the Authority. A domain is optional; proving it raises your limits and your agents' starting trust. */
  async register(name, { domain = null } = {}) {
    const ts = new Date().toISOString();
    const proof = C.sign(this.privateKey, C.canonical({ action: 'publisher', name, publicKey: this.publicKey, domain, ts }));
    const pow = C.solvePow(this.publicKey, ts, await this.#powBits());
    const p = await this.#post('/v1/publishers', { name, publicKey: this.publicKey, ts, proof, pow, domain });
    Object.assign(this, { id: p.id, name, domain });
    return p;
  }
  /** What to serve on your domain before calling verifyDomain(). */
  wellKnown() { return { path: '/.well-known/pehchaan-publisher.txt', content: this.id + '\n' }; }
  verifyDomain() { return this.#post(`/v1/publishers/${this.id}/verify`); }
  async status() { return (await fetch(`${this.authority}/v1/publishers/${this.id}`)).json(); }

  /**
   * Get a learner licence for a new agent. Creates the agent's own key (keep the returned identity secret),
   * signs the application as the publisher, and pays the proof-of-work stamp.
   */
  async applyForLicence({ name, purpose = '', model = 'unknown', provider = 'unknown' }) {
    if (!this.id) throw new Error('register the publisher first');
    const agent = PehchaanAgent.create(this.authority);
    const ts = new Date().toISOString();
    const claims = C.canonical({ action: 'apply', name, publisherId: this.id, publicKey: agent.publicKey, ts });
    const record = await this.#post('/v1/licences/apply', {
      publisherId: this.id, publisherSignature: C.sign(this.privateKey, claims), proof: C.sign(agent.privateKey, claims),
      name, purpose, model, provider, publicKey: agent.publicKey, ts, pow: C.solvePow(agent.publicKey, ts, await this.#powBits()),
    });
    agent.agentId = record.id;
    return { agent, record };
  }
}

module.exports = { Publisher };
