// Agent-side SDK. An agent holds only its own private key. It reaches files, databases and the
// treasury exclusively through the harness; it never holds a resource credential.
'use strict';
const fs = require('node:fs');
const C = require('./core');

class PehchaanAgent {
  constructor({ registry, privateKey, publicKey, agentId = null }) {
    Object.assign(this, { registry: registry.replace(/\/$/, ''), privateKey, publicKey, agentId });
  }
  static create(registry) { return new PehchaanAgent({ registry, ...C.generateKeyPair() }); }
  /** Load an identity file ({agentId, publicKey, privateKey}), e.g. data/genesis-agent.json. */
  static fromFile(registry, file) { return new PehchaanAgent({ registry, ...JSON.parse(fs.readFileSync(file, 'utf8')) }); }

  async call(method, path, body) {
    if (!this.agentId) throw new Error('agent has no identity yet');
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const nonce = C.randomToken(12);
    const signature = C.sign(this.privateKey, C.requestSigningString({ method, path, timestamp, nonce, body: raw }));
    const res = await fetch(this.registry + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-agent-id': this.agentId, 'x-agent-timestamp': timestamp, 'x-agent-nonce': nonce, 'x-agent-signature': signature },
      body: raw || undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${data.error}: ${data.message}`), { code: data.error, status: res.status, data });
    return data;
  }

  // ----- identity -----
  me() { return this.call('GET', '/v1/agent/me'); }
  card() { return this.call('POST', '/v1/agent/card', {}); }
  renew() { return this.call('POST', '/v1/agent/renew', {}); }
  retire(reason) { return this.call('POST', '/v1/agent/retire', { reason }); }
  async rotateKey() {
    const next = C.generateKeyPair();
    const ts = new Date().toISOString();
    const proof = C.sign(next.privateKey, C.canonical({ action: 'rotate', agentId: this.agentId, publicKey: next.publicKey, ts }));
    const rec = await this.call('POST', '/v1/agent/rotate-key', { publicKey: next.publicKey, proof, ts });
    Object.assign(this, next);
    return rec;
  }

  // ----- birth & lineage -----
  /** Give birth to a child agent. It gets its own fresh key and at most the roles this agent holds. */
  /** `bond`: trust this agent puts behind the child (starting trust = 40 + bond). Lost if the child is punished. */
  async spawn({ name, roles = [], purpose = '', limits, model, provider, bond = 0 }) {
    const child = PehchaanAgent.create(this.registry);
    const ts = new Date().toISOString();
    const proof = C.sign(child.privateKey, C.canonical({ action: 'spawn', name, parentId: this.agentId, publicKey: child.publicKey, ts }));
    const record = await this.call('POST', '/v1/agent/spawn', { name, roles, purpose, limits, model, provider, bond, publicKey: child.publicKey, ts, proof });
    child.agentId = record.id;
    return { child, record };
  }
  assignRole(agentId, role) { return this.call('POST', '/v1/agent/roles/assign', { agentId, role }); }
  revokeRole(agentId, role) { return this.call('POST', '/v1/agent/roles/revoke', { agentId, role }); }
  revokeDescendant(agentId, reason) { return this.call('POST', '/v1/agent/descendants/revoke', { agentId, reason }); }

  // ----- the harness: the only door to resources -----
  exec(resource, op, args = {}) { return this.call('POST', '/v1/harness/exec', { resource, op, args }); }
  readFile(p) { return this.exec('fs:' + p, 'read').then((r) => r.result.content); }
  writeFile(p, content) { return this.exec('fs:' + p, 'write', { content }); }
  listFiles(p) { return this.exec('fs:' + p, 'list').then((r) => r.result.entries); }
  deleteFile(p) { return this.exec('fs:' + p, 'delete'); }
  get home() { return `home/${this.agentId}`; }

  // ----- courts: just-in-time privileged access -----
  /** Purpose-bound: a transfer lease needs constraints {payees: [...], maxTotal}; the harness enforces them. */
  requestLease(resource, ops, { seconds = 600, justification = '', constraints } = {}) { return this.call('POST', '/v1/agent/leases', { resource, ops, seconds, justification, constraints }); }
  returnLease(id) { return this.call('POST', `/v1/agent/leases/${id}/return`, {}); }
  /** Cases this agent was drawn to judge (with evidence for appeals). */
  docket() { return this.call('GET', '/v1/agent/court'); }
  rule(reviewId, approve, note = '') { return this.call('POST', `/v1/agent/court/${reviewId}`, { approve, note }); }
  /** Challenge someone else's granted lease. Stakes trust; returned with a reward if upheld. */
  appeal(leaseId, grounds) { return this.call('POST', '/v1/agent/appeals', { leaseId, grounds }); }

  // ----- lending access to your own home -----
  grant(grantee, resource, ops, seconds = 3600) { return this.call('POST', '/v1/agent/grants', { grantee, resource, ops, seconds }); }
  revokeGrant(id) { return this.call('POST', `/v1/agent/grants/${id}/revoke`, {}); }

  // ----- Parliament: each house votes once, through its head -----
  /** Propose changing an amendable rule, e.g. proposeBill('courts.panelSize', 5, 'bigger panels resist cartels'). */
  proposeBill(path, value, rationale = '') { return this.call('POST', '/v1/agent/bills', { path, value, rationale }); }
  vote(billId, yes) { return this.call('POST', `/v1/agent/bills/${billId}/vote`, { yes }); }

  // ----- Licensing Office: from learner to full citizen -----
  /** Learner → full licence, once probation is over and the record is clean. */
  graduate() { return this.call('POST', '/v1/agent/graduate', {}); }
  /** Independents ask a court for a role, e.g. petitionRole('publisher', 'I publish weather notices'). */
  petitionRole(role, justification) { return this.call('POST', '/v1/agent/roles/petition', { role, justification }); }
  /** A house member offers to adopt an independent, posting a bond and granting roles it holds. */
  offerAdoption(agentId, roles = [], bond = 0) { return this.call('POST', '/v1/agent/adoptions', { agentId, roles, bond }); }
  adoptionOffers() { return this.call('GET', '/v1/agent/adoptions'); }
  acceptAdoption(offerId) { return this.call('POST', `/v1/agent/adoptions/${offerId}/accept`, {}); }

  /** Save this agent's identity (contains its private key: keep it secret). */
  save(file) { fs.writeFileSync(file, JSON.stringify({ agentId: this.agentId, publicKey: this.publicKey, privateKey: this.privateKey }, null, 2)); return file; }

  /** The licence number in its printed form, e.g. PA-7K4M-9QX2-H3TB. */
  get licenceNumber() { return this.agentId ? C.formatAgentId(this.agentId) : null; }

  /** Keep itself alive forever: renew before expiry, rotate keys on schedule. */
  autopilot({ renewWithinMs = 3 * 864e5, rotateEveryMs = 7 * 864e5, checkEveryMs = 3600_000, onEvent = () => {} } = {}) {
    let last = Date.now();
    const tick = async () => {
      try {
        const me = await this.me();
        if (Date.parse(me.expiresAt) - Date.now() < renewWithinMs) { await this.renew(); onEvent('renewed'); }
        if (Date.now() - last > rotateEveryMs) { await this.rotateKey(); last = Date.now(); onEvent('rotated'); }
      } catch (e) { onEvent('error', e); }
    };
    const t = setInterval(tick, checkEveryMs); tick();
    return () => clearInterval(t);
  }

  toJSON() { return { registry: this.registry, agentId: this.agentId, publicKey: this.publicKey, privateKey: this.privateKey }; }
}

module.exports = { PehchaanAgent };
