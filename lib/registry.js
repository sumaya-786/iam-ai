// Pehchaan registry: the IAM core of the agent state.
// Identity (citizenship), lineage (birth registry), roles (ministries), clearance, leases (courts),
// grants, trust, automatic enforcement (police) and the public gazette (audit).
// It is the Policy Decision Point. It never touches resources; only the harness does.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('./core');
const CONSTITUTION = require('./constitution');

const LEVELS = ['public', 'internal', 'confidential', 'critical'];
const SOFT_DENIALS = new Set(['lease_required']); // asking before the court has ruled is not a crime

/** "shop.ravilabs.in" → "ravilabs.in", "a.b.co.in" → "b.co.in": one verified publisher per website, not per subdomain. */
function registrableDomain(host = '') {
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return host;
  const l = host.toLowerCase().split('.');
  const second = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'nic', 'res', 'gen', 'firm', 'ind'];
  return (l.length >= 3 && l.at(-1).length === 2 && second.includes(l.at(-2)) ? l.slice(-3) : l.slice(-2)).join('.');
}
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; }

class GovError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

class Registry {
  constructor(dataDir, policy = {}) {
    // Deep copy: Parliament amends this registry's constitution in place, never the shared module.
    this.policy = structuredClone({ ...CONSTITUTION, ...policy });
    this.dir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbFile = path.join(dataDir, 'db.json');
    this.auditFile = path.join(dataDir, 'audit.jsonl');
    this.keyFile = path.join(dataDir, 'registry-key.json');

    this.db = fs.existsSync(this.dbFile) ? JSON.parse(fs.readFileSync(this.dbFile, 'utf8')) : {};
    for (const k of ['agents', 'reviews', 'leases', 'grants', 'spend', 'bans', 'houses', 'bills', 'publishers', 'adoptions']) this.db[k] ||= {};
    this.db.laws ||= [];
    for (const l of this.db.laws) setPath(this.policy, l.path, l.to); // enacted amendments survive restarts
    this.auditLog = fs.existsSync(this.auditFile)
      ? fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    if (!fs.existsSync(this.keyFile)) {
      const kp = C.generateKeyPair();
      fs.writeFileSync(this.keyFile, JSON.stringify({ ...kp, kid: 'reg-' + C.keyFingerprint(kp.publicKey) }, null, 2));
    }
    this.key = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
    const tokFile = path.join(dataDir, 'break-glass-token.txt');
    if (!fs.existsSync(tokFile)) fs.writeFileSync(tokFile, C.randomToken(32));
    this.breakGlassToken = process.env.PEHCHAAN_BREAK_GLASS_TOKEN || fs.readFileSync(tokFile, 'utf8').trim();

    this.nonces = new Map();
    this.rate = new Map();
    this.denials = new Map();
    if (!Object.keys(this.db.agents).length) this.#founding();
    this.#ensureCommons();
  }

  #save() {
    const tmp = this.dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.dbFile);
  }

  // ================= Founding: the one agent not born of another =================
  #founding() {
    const kp = C.generateKeyPair();
    const g = this.#createAgent({
      name: 'Genesis', publicKey: kp.publicKey, model: 'founding-agent', provider: 'pehchaan', purpose: 'First citizen. Gives birth to the ministries.',
      roles: this.#foundingRoles(),
      origin: 'genesis', limits: { maxTxnAmount: 1e7, dailySpend: 1e8, ratePerMinute: 600 },
      parentId: null, depth: 0, trust: this.policy.trust.genesis,
      expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
    });
    g.rootId = g.id;
    this.#save();
    fs.writeFileSync(path.join(this.dir, 'genesis-agent.json'), JSON.stringify({ agentId: g.id, ...kp }, null, 2));
    this.audit('state.founded', 'registry', g.id, { name: 'Genesis', roles: g.roles });
  }
  /** Genesis holds every role. Separation of duties binds its descendants, not the founder. */
  #foundingRoles() { return Object.keys(this.policy.roles); }

  // ================= Gazette (hash-chained public audit) =================
  audit(type, actor, subject, data = {}) {
    const prev = this.auditLog[this.auditLog.length - 1];
    const entry = { seq: this.auditLog.length + 1, ts: new Date().toISOString(), type, actor, subject, data, prevHash: prev ? prev.hash : '0'.repeat(64) };
    entry.hash = C.sha256(C.canonical(entry));
    this.auditLog.push(entry);
    fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n');
    return entry;
  }
  verifyAuditChain() {
    let prevHash = '0'.repeat(64);
    for (const e of this.auditLog) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prevHash || C.sha256(C.canonical(rest)) !== hash) return { intact: false, brokenAt: e.seq, entries: this.auditLog.length };
      prevHash = hash;
    }
    const head = { entries: this.auditLog.length, headHash: prevHash, at: new Date().toISOString() };
    return { intact: true, ...head, signedHead: C.signToken(head, this.key.privateKey, this.key.kid, 'audit-head+jwt') };
  }
  queryAudit({ agentId, limit = 200 } = {}) {
    let rows = this.auditLog;
    if (agentId) rows = rows.filter((e) => e.subject === agentId || e.actor === agentId);
    return rows.slice(-limit).reverse();
  }

  // ================= Self-maintenance (runs on every request) =================
  sweep() {
    const now = Date.now();
    let dirty = false;
    const decayMs = this.policy.roleDecayDays * 864e5;
    for (const a of Object.values(this.db.agents)) {
      if (a.status === 'quarantined' && Date.parse(a.quarantinedUntil) <= now) {
        a.status = 'active'; a.statusReason = null; a.quarantinedUntil = null;
        a.trust = Math.max(a.trust, this.policy.quarantine.releaseTrust);
        this.audit('agent.released', 'registry', a.id, { trust: a.trust, strikes: a.strikes });
        dirty = true;
      }
      if (a.status !== 'revoked' && a.origin !== 'genesis') {
        for (const r of [...a.roles]) {
          if (this.policy.defaultRoles.includes(r)) continue;
          if (now - Date.parse(a.roleActivity[r] || a.createdAt) > decayMs) {
            a.roles = a.roles.filter((x) => x !== r);
            delete a.roleActivity[r];
            this.audit('role.decayed', 'registry', a.id, { role: r, unusedDays: this.policy.roleDecayDays });
            dirty = true;
          }
        }
      }
    }
    for (const r of Object.values(this.db.reviews)) {
      if (r.status !== 'pending') continue;
      if (Date.parse(r.expiresAt) <= now) { this.#closeWithoutVerdict(r, 'expired'); dirty = true; continue; }
      if (this.#replaceNoShows(r, now)) dirty = true;
    }
    for (const l of Object.values(this.db.leases)) if (l.status === 'active' && Date.parse(l.expiresAt) <= now) {
      l.status = 'expired'; l.endedAt = l.expiresAt; dirty = true; this.audit('lease.expired', 'registry', l.agentId, { leaseId: l.id, resource: l.resource });
      this.#leaseEnded(l);
    }
    for (const g of Object.values(this.db.grants)) if (g.status === 'active' && Date.parse(g.expiresAt) <= now) { g.status = 'expired'; dirty = true; }
    for (const b of Object.values(this.db.bills)) {
      if (b.status === 'open' && this.#tally(b, now)) dirty = true;
      if (b.status === 'passed' && Date.parse(b.enactAt) <= now) { this.#enact(b); dirty = true; }
    }
    if (dirty) this.#save();
  }

  // ================= Trust =================
  /** Earned trust: each distinct deed counts once per day, and only up to a daily cap. */
  #earn(agent, key, amount) {
    const day = new Date().toISOString().slice(0, 10);
    if (!agent.earn || agent.earn.day !== day) agent.earn = { day, total: 0, seen: [] };
    if (agent.earn.seen.includes(key)) return 0;
    const gain = Math.min(amount, this.policy.trust.dailyEarnCap - agent.earn.total);
    if (gain <= 0) return 0;
    agent.earn.seen.push(key);
    if (agent.earn.seen.length > 500) agent.earn.seen.shift();
    agent.earn.total += gain;
    this.#adjustTrust(agent, gain, 'earned');
    return gain;
  }

  // ================= Police =================
  #adjustTrust(agent, delta, reason) {
    agent.trust = Math.max(0, Math.min(this.policy.trust.max, agent.trust + delta));
    if (agent.status === 'active' && !['genesis', 'registrar'].includes(agent.origin) && agent.trust < this.policy.quarantine.below) this.#quarantine(agent, `trust fell below ${this.policy.quarantine.below} (${reason})`);
  }
  #quarantine(agent, reason) {
    if (agent.status !== 'active') return;
    agent.strikes = (agent.strikes || 0) + 1;
    if (agent.strikes >= this.policy.quarantine.strikesToRevoke) this.#revoke(agent, `strike ${agent.strikes}: ${reason}`, 'registry');
    else {
      agent.status = 'quarantined'; agent.statusReason = reason;
      agent.quarantinedUntil = new Date(Date.now() + this.policy.quarantine.seconds * 1000).toISOString();
      this.audit('agent.quarantined', 'registry', agent.id, { reason, strikes: agent.strikes, until: agent.quarantinedUntil });
    }
    for (const l of Object.values(this.db.leases)) if (l.agentId === agent.id && l.status === 'active') { l.status = 'revoked'; l.endedAt = new Date().toISOString(); this.#leaseEnded(l); }
    // The parent pays: a flat penalty plus half the bond it posted for this child.
    const parent = agent.parentId && this.db.agents[agent.parentId];
    if (parent && parent.origin !== 'registrar') this.#adjustTrust(parent, this.policy.trust.childQuarantined - Math.ceil((agent.bond || 0) / 2), `child ${agent.id} quarantined`);
    if (agent.publisherId) this.#publisherStrike(agent.publisherId, `${agent.name} quarantined: ${reason}`);
  }
  #revoke(agent, reason, actor) {
    const affected = [agent.id];
    agent.status = 'revoked'; agent.statusReason = reason;
    // Police revocation forfeits the whole bond; retirement or a parent's own discipline releases it.
    const parent = agent.parentId && this.db.agents[agent.parentId];
    if (actor === 'registry' && parent && agent.bond) this.#adjustTrust(parent, -agent.bond, `bond forfeited for ${agent.id}`);
    // A publisher's agents share one reputation: when the police cancel one, its siblings pay too.
    if (actor === 'registry' && agent.publisherId) {
      for (const sib of Object.values(this.db.agents)) if (sib.publisherId === agent.publisherId && sib.id !== agent.id && sib.status === 'active') {
        this.#adjustTrust(sib, this.policy.licensing.publisherStrikes.siblingPenalty, `sibling ${agent.id} cancelled`);
      }
    }
    for (const d of this.descendants(agent.id)) if (d.status !== 'revoked') { d.status = 'revoked'; d.statusReason = `ancestor ${agent.id} revoked`; affected.push(d.id); }
    const ids = new Set(affected);
    for (const l of Object.values(this.db.leases)) if (ids.has(l.agentId) && ['active', 'pending'].includes(l.status)) {
      const wasActive = l.status === 'active';
      l.status = 'revoked'; l.endedAt = new Date().toISOString();
      if (wasActive) this.#leaseEnded(l);
    }
    for (const g of Object.values(this.db.grants)) if ((ids.has(g.grantor) || ids.has(g.grantee)) && g.status === 'active') g.status = 'revoked';
    this.audit('agent.revoked', actor, agent.id, { reason, cascade: affected.slice(1) });
    return affected;
  }

  // ================= Birth =================
  #checkProof(publicKey, proof, claims) {
    if (!publicKey || !proof || !claims.ts) throw new GovError(400, 'invalid', 'publicKey, ts and proof are required');
    if (Math.abs(Date.now() - Date.parse(claims.ts)) > this.policy.clockSkewMs) throw new GovError(400, 'stale_proof', 'proof timestamp outside allowed window');
    if (!C.verify(publicKey, C.canonical(claims), proof)) throw new GovError(400, 'bad_proof', 'proof of key possession failed');
    if (Object.values(this.db.agents).some((a) => a.publicKey === publicKey || a.keyHistory.some((k) => k.publicKey === publicKey))) {
      throw new GovError(409, 'key_reused', 'this public key is already bound to an agent');
    }
  }
  #limits(req = {}, caps) {
    const out = {};
    for (const k of ['maxTxnAmount', 'dailySpend', 'ratePerMinute']) {
      const v = Number(req[k] ?? caps[k]);
      if (!Number.isFinite(v) || v < 0) throw new GovError(400, 'invalid', `limits.${k} must be a non-negative number`);
      out[k] = Math.min(v, caps[k]);
    }
    return out;
  }
  #conflictsWith(role, held) {
    return this.policy.conflicts.find(([a, b]) => (role === a && held.includes(b)) || (role === b && held.includes(a)));
  }
  #checkRoles(roles) {
    if (!Array.isArray(roles)) throw new GovError(400, 'invalid', 'roles must be an array');
    for (const r of roles) if (!this.policy.roles[r]) throw new GovError(400, 'unknown_role', `no such role: ${r}`);
    for (const r of roles) { const c = this.#conflictsWith(r, roles); if (c) throw new GovError(403, 'separation_of_duties', `roles ${c[0]} and ${c[1]} cannot be held together`); }
  }

  /** Self-registration is closed: it made every newcomer its own house. Outsiders apply to the Licensing Office. */
  register() {
    throw new GovError(403, 'use_licensing_office', 'outside agents apply to the Licensing Office for a learner licence: POST /v1/licences/apply (see pehchaan-sdk Publisher)');
  }

  /** Birth: a parent gives birth to a child. The child can never exceed the parent. */
  spawn(parent, body) {
    const { name, publicKey, proof, ts, purpose = '', roles = [], limits = {}, model = parent.model, provider = parent.provider } = body;
    if (!name || typeof name !== 'string' || name.length > 80) throw new GovError(400, 'invalid', 'name (≤80 chars) is required');
    // Bond: the parent backs the child's starting trust with its own, and loses it if the child is punished.
    const bond = Math.floor(Number(body.bond) || 0);
    if (bond < 0 || bond > this.policy.trust.maxEndowment) throw new GovError(400, 'invalid', `bond must be 0–${this.policy.trust.maxEndowment}`);
    if (bond && parent.origin !== 'genesis') {
      const posted = Object.values(this.db.agents).filter((c) => c.parentId === parent.id && c.status !== 'revoked').reduce((s, c) => s + (c.bond || 0), 0);
      if (posted + bond > parent.trust) throw new GovError(403, 'insufficient_bond_capacity', `outstanding bonds (${posted}) + ${bond} would exceed your trust (${parent.trust})`);
    }
    if (parent.learner || this.houseOf(parent) === this.db.commonsId) throw new GovError(403, 'independents_cannot_spawn', 'independent agents in the Commons cannot create agents; be adopted by a ministry first');
    if (parent.trust < this.policy.trust.spawnMin) throw new GovError(403, 'insufficient_trust', `giving birth needs trust ≥ ${this.policy.trust.spawnMin}`);
    if (parent.depth + 1 > this.policy.maxDepth) throw new GovError(403, 'depth_exceeded', `lineage depth limit (${this.policy.maxDepth}) reached`);
    if (Object.values(this.db.agents).filter((d) => d.parentId === parent.id && d.status !== 'revoked' && d.origin !== 'registrar').length >= this.policy.maxChildren) {
      throw new GovError(403, 'too_many_children', `at most ${this.policy.maxChildren} living children`);
    }
    const all = [...new Set([...this.policy.defaultRoles, ...roles])];
    this.#checkRoles(all);
    const parentRoles = this.effectiveRoles(parent);
    const missing = all.filter((r) => !parentRoles.includes(r));
    if (missing.length) throw new GovError(403, 'role_escalation', `parent does not hold: ${missing.join(', ')}`);
    for (const k of ['maxTxnAmount', 'dailySpend', 'ratePerMinute']) {
      if (limits[k] !== undefined && Number(limits[k]) > parent.limits[k]) throw new GovError(403, 'limit_escalation', `child ${k} cannot exceed parent (${parent.limits[k]})`);
    }
    this.#checkProof(publicKey, proof, { action: 'spawn', name, parentId: parent.id, publicKey, ts });
    const child = this.#createAgent({
      name, publicKey, model, provider, purpose, roles: all, origin: 'born',
      limits: this.#limits({ ...this.policy.newbornCaps, ...limits }, parent.limits),
      parentId: parent.id, rootId: parent.rootId, depth: parent.depth + 1,
      trust: Math.min(parent.trust, this.policy.trust.initial + bond), bond,
      expiresAt: new Date(Math.min(Date.now() + this.policy.lifetimeDays * 864e5, Date.parse(parent.expiresAt))).toISOString(),
    });
    this.audit('agent.born', parent.id, child.id, { name, roles: all, depth: child.depth, bond });
    return child;
  }

  #createAgent(fields) {
    let id; do { id = C.newAgentId(); } while (this.db.agents[id]);
    const now = new Date().toISOString();
    const agent = {
      id, ...fields, keyFingerprint: C.keyFingerprint(fields.publicKey), strikes: 0,
      judicial: { rulings: 0, overturned: 0, disbarred: false },
      roleActivity: Object.fromEntries((fields.roles || []).map((r) => [r, now])),
      status: 'active', statusReason: null, quarantinedUntil: null, createdAt: now, keyHistory: [],
    };
    this.db.agents[id] = agent;
    this.#save();
    return agent;
  }

  // ================= Ministries: role administration down the lineage =================
  #isAncestor(anc, agent) { return this.chain(agent).slice(1).some((a) => a.id === anc.id); }
  assignRole(actor, targetId, role) {
    const t = this.#agent(targetId);
    if (!this.#isAncestor(actor, t)) throw new GovError(403, 'not_ancestor', 'only an ancestor can assign roles');
    if (!this.effectiveRoles(actor).includes(role)) throw new GovError(403, 'role_escalation', `you do not hold ${role}`);
    if (t.roles.includes(role)) return t;
    this.#checkRoles([...t.roles, role]);
    t.roles.push(role); t.roleActivity[role] = new Date().toISOString();
    this.#save();
    this.audit('role.assigned', actor.id, t.id, { role });
    return t;
  }
  revokeRole(actor, targetId, role) {
    const t = this.#agent(targetId);
    if (actor.id !== t.id && !this.#isAncestor(actor, t)) throw new GovError(403, 'not_ancestor', 'only the agent itself or an ancestor can revoke roles');
    if (this.policy.defaultRoles.includes(role)) throw new GovError(400, 'invalid', 'citizenship cannot be revoked; revoke the agent instead');
    const hit = [t, ...this.descendants(t.id)].filter((a) => a.roles.includes(role));
    hit.forEach((a) => { a.roles = a.roles.filter((r) => r !== role); delete a.roleActivity[role]; });
    this.#save();
    this.audit('role.revoked', actor.id, t.id, { role, cascade: hit.slice(1).map((a) => a.id) });
    return t;
  }
  /** A role only counts if every ancestor still holds it too. */
  effectiveRoles(agent) {
    const chain = this.chain(agent).slice(1);
    return agent.roles.filter((r) => chain.every((a) => a.roles.includes(r)));
  }

  // ================= Clearance & resources =================
  clearanceOf(agent) {
    let lvl = 'public';
    for (const l of LEVELS) if (agent.trust >= this.policy.clearance[l]) lvl = l;
    return lvl;
  }
  resourceInfo(resource) { return this.policy.resources.find((r) => C.globMatch(r.pattern, resource)) || null; }
  #homeOf(agent) { return `fs:home/${agent.id}`; }
  owns(agent, resource) { const h = this.#homeOf(agent); return resource === h || resource.startsWith(h + '/'); }

  /** Which legal basis lets this agent do `op` on `resource`? (owner > role > grant). Null if none. */
  #basis(agent, resource, op) {
    if (this.owns(agent, resource)) return 'owner';
    for (const r of this.effectiveRoles(agent)) {
      if (this.policy.roles[r].permissions.some((p) => C.globMatch(p.resource, resource) && C.opMatch(p.ops, op))) return 'role:' + r;
    }
    const g = Object.values(this.db.grants).find((x) => x.grantee === agent.id && x.status === 'active' && Date.parse(x.expiresAt) > Date.now()
      && (resource === x.resource || resource.startsWith(x.resource + '/')) && C.opMatch(x.ops, op));
    if (g && this.effectiveStatus(this.db.agents[g.grantor]).ok) return 'grant:' + g.id;
    return null;
  }
  #activeLease(agent, resource, op) {
    return Object.values(this.db.leases).find((l) => l.agentId === agent.id && l.status === 'active' && Date.parse(l.expiresAt) > Date.now()
      && C.globMatch(l.resource, resource) && C.opMatch(l.ops, op));
  }

  // ================= Policy Decision Point =================
  authorize(agent, { resource, op, amount = 0, target = null }) {
    if (!resource || typeof resource !== 'string' || !op || typeof op !== 'string') throw new GovError(400, 'invalid', 'resource and op are required');
    if (resource.includes('..') || resource.includes('\\') || resource.includes('//')) throw new GovError(400, 'invalid', 'malformed resource path');
    amount = Number(amount) || 0;
    if (amount < 0) throw new GovError(400, 'invalid', 'amount cannot be negative');
    const P = this.policy;
    const reasons = [];
    const st = this.effectiveStatus(agent);
    if (!st.ok) reasons.push(st.reason);

    const now = Date.now();
    const recent = (this.rate.get(agent.id) || []).filter((t) => now - t < 60_000);
    recent.push(now); this.rate.set(agent.id, recent);
    if (recent.length > agent.limits.ratePerMinute) reasons.push('rate_limited');

    if (P.forbidden.some((f) => C.globMatch(f.resource, resource) && C.opMatch(f.ops, op))) reasons.push('forbidden_by_constitution');
    const info = this.resourceInfo(resource);
    if (!info) reasons.push('unknown_resource');

    const basis = info ? this.#basis(agent, resource, op) : null;
    if (info && !basis) reasons.push('no_permission');

    let lease = null;
    if (info) {
      const cls = info.classification;
      if (agent.trust < P.clearance[cls] && basis !== 'owner') reasons.push(`clearance:${this.clearanceOf(agent)}<${cls}`);
      if (cls === 'critical' && basis) { lease = this.#activeLease(agent, resource, op); if (!lease) reasons.push('lease_required'); }
    }
    // Purpose binding: a lease only covers the payees / keys and the total the court approved.
    const k = lease?.constraints;
    if (k) {
      if (k.payees && op === 'transfer' && !k.payees.includes(String(target))) reasons.push('outside_lease_purpose:payee');
      if (k.keys && !k.keys.includes(String(target))) reasons.push('outside_lease_purpose:key');
      if (k.maxTotal && op === 'transfer' && (lease.used?.total || 0) + amount > k.maxTotal) reasons.push('exceeds_lease_total');
    }

    const day = new Date().toISOString().slice(0, 10);
    const spent = (this.db.spend[agent.id] || {})[day] || 0;
    if (amount > 0) {
      if (amount > agent.limits.maxTxnAmount) reasons.push('exceeds_txn_limit');
      if (spent + amount > agent.limits.dailySpend) reasons.push('exceeds_daily_limit');
    }

    const decision = reasons.length ? 'deny' : 'allow';
    if (decision === 'allow') {
      if (amount > 0) this.db.spend[agent.id] = { ...(this.db.spend[agent.id] || {}), [day]: spent + amount };
      if (lease && amount > 0) lease.used = { total: (lease.used?.total || 0) + amount };
      if (basis.startsWith('role:')) agent.roleActivity[basis.slice(5)] = new Date().toISOString();
    }
    if (st.ok) {
      if (decision === 'allow' && basis !== 'owner') this.#earn(agent, `${resource}#${op}`, 1); // self-dealing earns nothing
      else if (!reasons.every((r) => SOFT_DENIALS.has(r))) {
        const d = (this.denials.get(agent.id) || []).filter((t) => now - t < P.quarantine.burstWindowMs);
        d.push(now); this.denials.set(agent.id, d);
        this.#adjustTrust(agent, P.trust.deny, 'violation');
        if (agent.status === 'active' && agent.origin !== 'genesis' && d.length >= P.quarantine.burstDenials) {
          this.denials.delete(agent.id); this.#quarantine(agent, `${d.length} violations in ${P.quarantine.burstWindowMs / 1000}s`);
        }
      }
    }
    this.#save();
    const entry = this.audit('access.' + decision, agent.id, agent.id, { resource, op, amount: amount || undefined, basis: basis || undefined, lease: lease?.id, reasons, trust: agent.trust });
    return { decision, reasons, basis, leaseId: lease?.id || null, classification: info?.classification || null, trust: agent.trust, status: agent.status, auditSeq: entry.seq };
  }

  /** Signed receipt for an access decision, verifiable by anyone with the registry key. */
  receipt(agent, d, extra = {}) {
    const now = Math.floor(Date.now() / 1000);
    return C.signToken({ iss: 'pehchaan-registry', sub: agent.id, ...extra, decision: d.decision, basis: d.basis, reasons: d.reasons, auditSeq: d.auditSeq, iat: now, exp: now + 300 },
      this.key.privateKey, this.key.kid, 'decision+jwt');
  }

  // ================= Courts: anti-collusion judiciary =================
  // Judges are drawn by verifiable lot (never self-selected), one per house, never from the petitioner's
  // house, never someone the petitioner recently favoured. Panels and votes are sealed until the verdict.
  // Granted leases can be appealed with evidence; approvers of an overturned lease are slashed.

  /** A house is the lineage under one child of Genesis. Families cannot judge their own. */
  houseOf(agent) {
    if (agent.origin === 'genesis') return null;
    if (agent.depth === 0) return agent.id;
    const c = this.chain(agent);
    return c[c.length - 2].id;
  }
  #auditHead() { return this.auditLog.length ? this.auditLog[this.auditLog.length - 1].hash : '0'.repeat(64); }

  /** Has `subject` approved a petition by `judge` recently? Then `judge` may not sit on `subject`'s case. */
  #owesFavour(judge, subject) {
    const since = Date.now() - this.policy.courts.reciprocityDays * 864e5;
    return Object.values(this.db.reviews).some((r) => r.agentId === judge.id && Date.parse(r.createdAt) > since
      && r.votes.some((v) => v.by === subject.id && v.approve));
  }
  #judgeBlock(j, subject, excludeIds, excludeHouses) {
    const K = this.policy.courts;
    if (j.origin === 'genesis' || j.origin === 'registrar') return 'founder_does_not_sit';
    if (j.learner) return 'learner';
    if (excludeIds.includes(j.id)) return 'excluded';
    if (!this.effectiveStatus(j).ok) return 'inactive';
    if (j.trust < K.judgeMinTrust) return 'low_trust';
    if ((Date.now() - Date.parse(j.createdAt)) / 1000 < K.judgeMinAgeSeconds) return 'too_young';
    if (j.judicial?.disbarred) return 'disbarred';
    if (excludeHouses.includes(this.houseOf(j))) return 'same_house';
    const hr = this.db.houses[this.houseOf(j)];
    if (hr?.suspendedUntil && Date.parse(hr.suspendedUntil) > Date.now()) return 'house_suspended';
    if (this.#owesFavour(j, subject)) return 'reciprocity';
    return null;
  }

  /** Judges once overturned together: never seated on the same panel again (until the ban lapses). */
  #bansOf(id) {
    const now = Date.now();
    return Object.values(this.db.bans).filter((b) => (b.a === id || b.b === id) && Date.parse(b.until) > now).map((b) => (b.a === id ? b.b : b.a));
  }

  /**
   * Deterministic, trust-weighted sampling without replacement: at most one judge per house, and never two judges
   * who are banned from sitting together. Anyone can re-run it from the published pool and seed.
   */
  static sortition(pool, seed, size, takenHouses = [], takenIds = []) {
    const chosen = []; const houses = new Set(takenHouses);
    const seated = () => [...takenIds, ...chosen];
    for (let i = 0; chosen.length < size; i++) {
      const cands = pool.filter((c) => !houses.has(c.house) && !chosen.includes(c.id) && !seated().some((s) => (c.bans || []).includes(s)));
      if (!cands.length) break;
      const total = cands.reduce((s, c) => s + c.weight, 0);
      let x = (parseInt(C.sha256(`${seed}:${i}`).slice(0, 12), 16) / 2 ** 48) * total;
      let pick = cands[cands.length - 1];
      for (const c of cands) { if (x < c.weight) { pick = c; break; } x -= c.weight; }
      chosen.push(pick.id); houses.add(pick.house);
    }
    return chosen;
  }

  #draw(review, size) {
    const subject = this.db.agents[review.agentId];
    const takenHouses = review.panel.map((p) => p.house);
    const pool = Object.values(this.db.agents)
      .filter((j) => !this.#judgeBlock(j, subject, review.excludeIds, review.excludeHouses) && !takenHouses.includes(this.houseOf(j)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((j) => ({ id: j.id, house: this.houseOf(j), weight: j.trust, bans: this.#bansOf(j.id) }));
    const seed = C.sha256(`${review.id}:${review.draws.length}:${this.#auditHead()}`); // committed to the public gazette head
    const takenIds = review.panel.map((p) => p.judge);
    const selected = Registry.sortition(pool, seed, size, takenHouses, takenIds);
    review.draws.push({ seed, size, takenHouses, takenIds, pool, selected, at: new Date().toISOString() });
    const now = new Date().toISOString();
    for (const id of selected) { review.panel.push({ judge: id, house: this.houseOf(this.db.agents[id]), assignedAt: now }); review.excludeIds.push(id); }
    return selected;
  }
  /** Re-run every draw of a closed case from its published pool and seed. */
  verifyDraw(reviewId) {
    const r = this.db.reviews[reviewId];
    if (!r) throw new GovError(404, 'not_found', 'review not found');
    if (r.status === 'pending') throw new GovError(409, 'sealed', 'draws are published after the verdict');
    const draws = r.draws.map((d) => ({ seed: d.seed, poolSize: d.pool.length, selected: d.selected, recomputed: Registry.sortition(d.pool, d.seed, d.size, d.takenHouses, d.takenIds || []) }));
    return { reviewId, valid: draws.every((d) => d.recomputed.join() === d.selected.join()), draws };
  }

  #openCase(fields, size) {
    const now = Date.now();
    const review = {
      id: 'rev_' + C.randomToken(9), ...fields, panel: [], votes: [], draws: [],
      quorum: Math.floor(size / 2) + 1, status: 'pending',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.policy.courts.reviewTtlMs).toISOString(),
    };
    this.#draw(review, size);
    if (review.panel.length < size) {
      throw new GovError(503, 'no_court', `cannot convene ${size} independent judges (found ${review.panel.length}); need more trusted agents from other houses`);
    }
    this.db.reviews[review.id] = review;
    return review;
  }

  /** Purpose binding: what exactly the court is being asked to allow. Transfers must name payees and a total. */
  #constraints(agent, ops, c = {}) {
    const out = {};
    if (ops.includes('transfer')) {
      if (!Array.isArray(c.payees) || !c.payees.length || c.payees.length > this.policy.leases.maxPayees || !c.payees.every((p) => typeof p === 'string' && p.length <= 80)) {
        throw new GovError(400, 'purpose_required', `a transfer lease must name 1–${this.policy.leases.maxPayees} payees`);
      }
      const max = Number(c.maxTotal);
      if (!(max > 0)) throw new GovError(400, 'purpose_required', 'a transfer lease must state maxTotal');
      if (max > agent.limits.dailySpend) throw new GovError(403, 'limit_escalation', `maxTotal exceeds your daily limit (${agent.limits.dailySpend})`);
      out.payees = [...new Set(c.payees)]; out.maxTotal = max;
    }
    if (Array.isArray(c.keys) && c.keys.length) out.keys = c.keys.map(String).slice(0, 100);
    return Object.keys(out).length ? out : null;
  }

  requestLease(agent, { resource, ops, seconds = 600, justification = '', constraints }) {
    const st = this.effectiveStatus(agent);
    if (!st.ok) throw new GovError(403, st.reason, 'inactive agents cannot petition');
    if (!Array.isArray(ops) || !ops.length) throw new GovError(400, 'invalid', 'ops must be a non-empty array');
    const info = this.resourceInfo(resource);
    if (!info) throw new GovError(404, 'unknown_resource', 'no such resource');
    seconds = Math.min(Number(seconds) || 600, this.policy.leases.maxSeconds);
    for (const op of ops) if (!this.#basis(agent, resource, op)) throw new GovError(403, 'no_permission', `a lease activates powers you already hold; you have no ${op} on ${resource}`);
    if (agent.trust < this.policy.clearance[info.classification]) throw new GovError(403, 'insufficient_clearance', `${info.classification} needs trust ≥ ${this.policy.clearance[info.classification]}`);
    const purpose = this.#constraints(agent, ops, constraints);
    const lease = { id: 'lse_' + C.randomToken(9), agentId: agent.id, resource, ops, seconds, justification: String(justification).slice(0, 500), constraints: purpose, used: { total: 0 }, status: 'pending', requestedAt: new Date().toISOString() };
    const big = (purpose?.maxTotal || 0) >= this.policy.courts.largePanel.threshold;
    const review = this.#openCase({
      kind: 'lease', leaseId: lease.id, agentId: agent.id, resource, ops, justification: lease.justification, constraints: purpose,
      excludeIds: [agent.id], excludeHouses: [this.houseOf(agent)],
    }, big ? this.policy.courts.largePanel.size : this.policy.courts.panelSize);
    lease.reviewId = review.id;
    this.db.leases[lease.id] = lease;
    this.#save();
    this.audit('lease.petitioned', agent.id, agent.id, { leaseId: lease.id, reviewId: review.id, resource, ops, seconds, justification: lease.justification, panelSize: review.panel.length });
    return { lease, review: this.publicReview(review) };
  }

  /** Appeal: any trusted outsider can challenge a granted lease, staking its own trust. */
  fileChallenge(challenger, { leaseId, grounds = '' }) {
    const K = this.policy.courts, A = K.appeal;
    const l = this.db.leases[leaseId];
    if (!l) throw new GovError(404, 'not_found', 'lease not found');
    if (!l.activatedAt) throw new GovError(409, 'not_challengeable', 'only granted leases can be appealed');
    if (Date.now() - Date.parse(l.activatedAt) > A.windowDays * 864e5) throw new GovError(409, 'appeal_window_closed', `appeals close after ${A.windowDays} days`);
    if (Object.values(this.db.reviews).some((r) => r.kind !== 'lease' && r.leaseId === leaseId && ['pending', 'upheld', 'dismissed'].includes(r.status))) throw new GovError(409, 'already_reviewed', 'this lease has already been appealed or audited');
    const st = this.effectiveStatus(challenger);
    if (!st.ok) throw new GovError(403, st.reason, 'inactive agents cannot appeal');
    if (challenger.trust < A.challengerMinTrust) throw new GovError(403, 'insufficient_trust', `appeals need trust ≥ ${A.challengerMinTrust}`);
    const petitioner = this.db.agents[l.agentId];
    if (challenger.id === petitioner.id) throw new GovError(400, 'invalid', 'you cannot appeal your own lease');
    if (this.houseOf(challenger) === this.houseOf(petitioner)) throw new GovError(403, 'same_house', 'families do not police themselves in court; another house must appeal');
    if (!String(grounds).trim()) throw new GovError(400, 'invalid', 'grounds are required');
    const original = this.db.reviews[l.reviewId];
    const review = this.#openCase({
      kind: 'appeal', leaseId, agentId: petitioner.id, challengerId: challenger.id, grounds: String(grounds).slice(0, 500),
      resource: l.resource, ops: l.ops, justification: l.justification, evidence: this.leaseEvidence(l),
      excludeIds: [petitioner.id, challenger.id, ...original.panel.map((p) => p.judge), ...original.excludeIds],
      excludeHouses: [this.houseOf(petitioner), this.houseOf(challenger)],
    }, K.appealPanelSize);
    this.#adjustTrust(challenger, -A.stake, 'appeal stake');
    review.stake = A.stake;
    this.#save();
    this.audit('appeal.filed', challenger.id, petitioner.id, { reviewId: review.id, leaseId, grounds: review.grounds, stake: A.stake, evidence: review.evidence.length });
    return this.publicReview(review);
  }
  /** What the lessee actually did under the lease, straight from the gazette. */
  leaseEvidence(l) {
    const from = Date.parse(l.activatedAt), to = Date.parse(l.endedAt || l.expiresAt);
    return this.auditLog.filter((e) => e.actor === l.agentId && Date.parse(e.ts) >= from && Date.parse(e.ts) <= to
      && ((e.type.startsWith('access.') && e.data.resource === l.resource) || e.type === 'treasury.transfer'))
      .map((e) => ({ seq: e.seq, type: e.type, op: e.data.op, amount: e.data.amount, to: e.data.to, reasons: e.data.reasons }));
  }

  /**
   * Automatic audit when a lease ends. No complaint needed. Triggered by any dissent on the original panel, by
   * high value, or by a verifiable lottery. The audit panel comes only from houses that did NOT sit on the original
   * case, so a cartel must win two independent draws on disjoint houses.
   */
  #leaseEnded(l) {
    if (!l.activatedAt || l.audited) return;
    const A = this.policy.courts.audit;
    const original = this.db.reviews[l.reviewId];
    const dissent = original?.votes.some((v) => !v.approve);
    const big = Math.max(l.used?.total || 0, l.constraints?.maxTotal || 0) >= A.alwaysAboveTotal;
    const seed = C.sha256(`audit:${l.id}:${this.#auditHead()}`);
    const roll = parseInt(seed.slice(0, 12), 16) / 2 ** 48;
    const why = A.alwaysIfDissent && dissent ? 'dissent' : big ? 'high_value' : roll < A.rate ? 'lottery' : null;
    this.audit('audit.lottery', 'registry', l.agentId, { leaseId: l.id, seed, roll: Number(roll.toFixed(4)), rate: A.rate, selected: !!why, reason: why || undefined });
    if (!why) return;
    l.audited = true;
    const petitioner = this.db.agents[l.agentId];
    try {
      const review = this.#openCase({
        kind: 'audit', leaseId: l.id, agentId: l.agentId, challengerId: null, grounds: `automatic audit (${why})`,
        resource: l.resource, ops: l.ops, justification: l.justification, constraints: l.constraints, evidence: this.leaseEvidence(l),
        excludeIds: [l.agentId, ...original.panel.map((p) => p.judge), ...original.excludeIds],
        excludeHouses: [this.houseOf(petitioner), ...original.panel.map((p) => p.house)],
      }, this.policy.courts.appealPanelSize);
      this.audit('audit.opened', 'registry', l.agentId, { reviewId: review.id, leaseId: l.id, reason: why, evidence: review.evidence.length });
    } catch (e) {
      if (e.code !== 'no_court') throw e;
      l.auditUnconvened = true; // published, so outside observers can see which leases escaped review
      this.audit('audit.no_court', 'registry', l.agentId, { leaseId: l.id, reason: why });
    }
  }

  /** Cartel penalties: approvers overturned together are banned from sitting together; their houses take strikes. */
  #punishCartel(original) {
    const K = this.policy.courts;
    const now = Date.now();
    const approvers = original.votes.filter((v) => v.approve).map((v) => v.by);
    for (let i = 0; i < approvers.length; i++) for (let k = i + 1; k < approvers.length; k++) {
      const [a, b] = [approvers[i], approvers[k]].sort();
      this.db.bans[`${a}:${b}`] = { a, b, since: new Date(now).toISOString(), until: new Date(now + K.coOverturnBanDays * 864e5).toISOString(), reason: `overturned together in ${original.id}` };
      this.audit('court.pair_banned', 'court', a, { with: b, days: K.coOverturnBanDays, reviewId: original.id });
    }
    const H = K.houseBench;
    for (const id of approvers) {
      const house = this.houseOf(this.db.agents[id]);
      const rec = (this.db.houses[house] ||= { strikes: [] });
      rec.strikes = rec.strikes.filter((t) => now - Date.parse(t) < H.windowDays * 864e5);
      rec.strikes.push(new Date(now).toISOString());
      if (rec.strikes.length >= H.suspendAfter && !(rec.suspendedUntil && Date.parse(rec.suspendedUntil) > now)) {
        rec.suspendedUntil = new Date(now + H.suspendDays * 864e5).toISOString();
        this.audit('house.suspended', 'court', house, { strikes: rec.strikes.length, until: rec.suspendedUntil });
      }
    }
  }

  /** Cases waiting for this judge. Only assigned judges ever see a case before its verdict. */
  docket(judge) {
    return Object.values(this.db.reviews)
      .filter((r) => r.status === 'pending' && r.panel.some((p) => p.judge === judge.id) && !r.votes.some((v) => v.by === judge.id))
      .map((r) => ({ ...this.publicReview(r), evidence: r.evidence, grounds: r.grounds, constraints: r.constraints }));
  }

  rule(judge, reviewId, { approve, note = '' }) {
    const r = this.db.reviews[reviewId];
    if (!r) throw new GovError(404, 'not_found', 'review not found');
    if (r.status !== 'pending') throw new GovError(409, 'closed', `review is ${r.status}`);
    if (!r.panel.some((p) => p.judge === judge.id)) throw new GovError(403, 'not_on_panel', 'only judges drawn by lot may rule on this case');
    if (r.votes.some((v) => v.by === judge.id)) throw new GovError(409, 'already_ruled', 'you already voted');
    if (!this.effectiveStatus(judge).ok) throw new GovError(403, 'judge_inactive', 'inactive judges cannot rule');
    r.votes.push({ by: judge.id, approve: !!approve, note: String(note).slice(0, 280), at: new Date().toISOString() });
    judge.judicial = { rulings: 0, overturned: 0, disbarred: false, ...judge.judicial };
    judge.judicial.rulings++;
    this.#earn(judge, 'judicial:' + r.id, this.policy.courts.serviceReward);
    this.audit('court.vote_sealed', judge.id, r.agentId, { reviewId }); // the vote itself stays sealed until the verdict
    const yes = r.votes.filter((v) => v.approve).length, no = r.votes.length - yes;
    if (yes >= r.quorum) this.#verdict(r, true);
    else if (no >= r.quorum) this.#verdict(r, false);
    this.#save();
    return this.publicReview(r);
  }

  #verdict(r, yes) {
    const K = this.policy.courts;
    const lease = this.db.leases[r.leaseId];
    const petitioner = this.db.agents[r.agentId];
    const now = new Date().toISOString();
    if (r.kind === 'role') {
      r.status = yes ? 'approved' : 'rejected';
      if (yes && petitioner && !petitioner.roles.includes(r.role)) {
        petitioner.roles.push(r.role); petitioner.roleActivity[r.role] = now;
        this.audit('role.granted', 'court', petitioner.id, { role: r.role, reviewId: r.id });
      } else if (!yes && petitioner) this.#adjustTrust(petitioner, this.policy.trust.reviewRejected, 'role petition rejected');
    } else if (r.kind === 'lease') {
      r.status = yes ? 'approved' : 'rejected';
      if (yes) {
        Object.assign(lease, { status: 'active', activatedAt: now, expiresAt: new Date(Date.now() + lease.seconds * 1000).toISOString(), judges: r.votes.filter((v) => v.approve).map((v) => v.by) });
        this.audit('lease.granted', 'court', lease.agentId, { leaseId: lease.id, resource: lease.resource, ops: lease.ops, until: lease.expiresAt });
      } else {
        lease.status = 'rejected';
        if (petitioner) this.#adjustTrust(petitioner, this.policy.trust.reviewRejected, 'petition rejected');
      }
    } else {
      r.status = yes ? 'upheld' : 'dismissed';
      const challenger = this.db.agents[r.challengerId];
      if (yes) {
        if (lease.status === 'active') { lease.status = 'revoked'; lease.endedAt = now; }
        lease.overturned = true;
        const how = r.kind === 'audit' ? 'audit' : 'appeal';
        if (petitioner) { this.#adjustTrust(petitioner, K.appeal.misusePenalty, `lease misuse upheld on ${how}`); this.#quarantine(petitioner, `lease misuse upheld on ${how}`); }
        const original = this.db.reviews[lease.reviewId];
        this.#punishCartel(original);
        for (const v of original.votes) {
          const j = this.db.agents[v.by]; if (!j) continue;
          j.judicial = { rulings: 0, overturned: 0, disbarred: false, ...j.judicial };
          if (v.approve) {
            j.judicial.overturned++;
            if (j.judicial.overturned >= K.disbarAfterOverturned) j.judicial.disbarred = true;
            this.#adjustTrust(j, K.slash, 'approved a lease overturned on appeal');
            this.audit('court.slashed', 'court', j.id, { reviewId: original.id, penalty: K.slash, overturned: j.judicial.overturned, disbarred: j.judicial.disbarred });
          } else {
            this.#adjustTrust(j, K.objectorReward, 'dissent vindicated on appeal');
          }
        }
        if (challenger) this.#adjustTrust(challenger, r.stake + K.appeal.reward, 'appeal upheld');
      }
      // Dismissed appeal: the challenger's stake stays forfeited (frivolous appeals are expensive). Dismissed audit: clean.
    }
    this.audit('court.verdict', 'court', r.agentId, { reviewId: r.id, kind: r.kind, verdict: r.status, votes: r.votes.map((v) => ({ by: v.by, approve: v.approve })) });
  }

  #closeWithoutVerdict(r, status) {
    r.status = status;
    const l = this.db.leases[r.leaseId];
    if (r.kind === 'lease' && l && l.status === 'pending') l.status = 'expired';
    if (r.kind === 'appeal') { const c = this.db.agents[r.challengerId]; if (c) this.#adjustTrust(c, r.stake, 'appeal lapsed: stake returned'); }
    this.audit('court.' + status, 'court', r.agentId, { reviewId: r.id, kind: r.kind });
  }

  /** Judges who sit on a case and do not rule in time are replaced by a fresh draw and penalised. */
  #replaceNoShows(r, now) {
    const K = this.policy.courts;
    const late = r.panel.filter((p) => !r.votes.some((v) => v.by === p.judge) && now - Date.parse(p.assignedAt) > K.judgeDeadlineMs);
    if (!late.length) return false;
    for (const p of late) {
      r.panel = r.panel.filter((x) => x !== p);
      const j = this.db.agents[p.judge];
      if (j) this.#adjustTrust(j, K.noShowPenalty, 'missed a hearing');
      this.audit('court.no_show', 'court', p.judge, { reviewId: r.id });
    }
    this.#draw(r, late.length);
    if (r.panel.length < r.quorum) this.#closeWithoutVerdict(r, 'no_court'); // not enough independent judges left
    return true;
  }

  /** Public view: panels and votes are sealed until the verdict. */
  publicReview(r) {
    const { draws, excludeIds, excludeHouses, ...rest } = r;
    if (r.status === 'pending') {
      return { ...rest, panel: undefined, votes: undefined, panelSize: r.panel.length, votesCast: r.votes.length, evidence: r.evidence ? r.evidence.length : undefined, sealed: true };
    }
    return { ...rest, panelSize: r.panel.length, votesCast: r.votes.length, drawSeeds: draws.map((d) => d.seed), sealed: false };
  }

  endLease(agent, leaseId) {
    const l = this.db.leases[leaseId];
    if (!l || l.agentId !== agent.id) throw new GovError(404, 'not_found', 'lease not found');
    if (l.status === 'active') {
      l.status = 'returned'; l.endedAt = new Date().toISOString();
      this.audit('lease.returned', agent.id, agent.id, { leaseId });
      this.#leaseEnded(l);
      this.#save();
    }
    return l;
  }

  // ================= Licensing Office: agents built by anyone =================
  /** The Commons: one house for every independent agent. Run by code; nobody holds its key; no seat in Parliament. */
  #ensureCommons() {
    if (this.db.commonsId && this.db.agents[this.db.commonsId]) return;
    const genesis = Object.values(this.db.agents).find((a) => a.origin === 'genesis');
    const c = this.#createAgent({
      name: 'Commons', publicKey: C.generateKeyPair().publicKey, model: 'registrar', provider: 'pehchaan',
      purpose: 'The Licensing Office: home of independent agents', origin: 'registrar',
      roles: [...new Set([...this.policy.defaultRoles, ...this.policy.licensing.courtGrantableRoles])],
      limits: { maxTxnAmount: 0, dailySpend: 0, ratePerMinute: 0 }, parentId: genesis.id, rootId: genesis.rootId, depth: 1,
      trust: 100, bond: 0, expiresAt: genesis.expiresAt,
    });
    this.db.commonsId = c.id;
    this.#save();
    this.audit('commons.founded', 'registry', c.id, { name: 'Commons' });
  }
  get commonsId() { return this.db.commonsId; }

  #publisherSuspended(p) { return !!(p.suspendedUntil && Date.parse(p.suspendedUntil) > Date.now()); }
  #publisherView(id) {
    const p = id && this.db.publishers[id];
    return p ? { id: p.id, name: p.name, domain: p.domain, verified: p.verified, suspended: this.#publisherSuspended(p) } : null;
  }

  /** Step 1: the developer registers as a publisher with their own key (and, optionally, a web domain to prove). */
  registerPublisher({ name, publicKey, ts, proof, pow, domain = null }) {
    if (!name || typeof name !== 'string' || name.length > 80) throw new GovError(400, 'invalid', 'name (≤80 chars) is required');
    if (domain !== null && !/^[a-z0-9.-]+(:\d{2,5})?$/i.test(String(domain))) throw new GovError(400, 'invalid', 'domain must be a bare hostname like example.com');
    if (!publicKey || !proof || !ts) throw new GovError(400, 'invalid', 'publicKey, ts and proof are required');
    if (Math.abs(Date.now() - Date.parse(ts)) > this.policy.clockSkewMs) throw new GovError(400, 'stale_proof', 'proof timestamp outside allowed window');
    if (!C.verify(publicKey, C.canonical({ action: 'publisher', name, publicKey, domain, ts }), proof)) throw new GovError(400, 'bad_proof', 'proof of key possession failed');
    if (!C.powValid(publicKey, ts, String(pow ?? ''), this.policy.licensing.powBits)) throw new GovError(400, 'bad_pow', `proof of work must have ${this.policy.licensing.powBits} leading zero bits`);
    const id = 'pub_' + C.keyFingerprint(publicKey);
    if (this.db.publishers[id]) throw new GovError(409, 'exists', 'this publisher key is already registered');
    const p = { id, name, publicKey, domain: domain ? String(domain).toLowerCase() : null, verified: false, strikes: [], suspendedUntil: null, createdAt: new Date().toISOString() };
    this.db.publishers[id] = p;
    this.#save();
    this.audit('publisher.registered', 'registrar', id, { name, domain: p.domain });
    return this.publisherPublic(p);
  }

  /** Optional: prove the domain by serving the publisher id at /.well-known/pehchaan-publisher.txt (like ACME http-01). */
  async verifyPublisherDomain(id) {
    const p = this.db.publishers[id];
    if (!p) throw new GovError(404, 'not_found', 'publisher not found');
    if (!p.domain) throw new GovError(400, 'no_domain', 'this publisher registered without a domain');
    const host = p.domain;
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    if (local && !this.policy.licensing.allowInsecureDomains) throw new GovError(400, 'domain_not_allowed', 'localhost domains are only allowed in development');
    if (!local && (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /(^|\.)(local|internal|localhost)$/.test(host))) {
      throw new GovError(400, 'domain_not_allowed', 'use a public hostname on the standard HTTPS port');
    }
    const base = registrableDomain(host);
    const taken = Object.values(this.db.publishers).find((o) => o.id !== p.id && o.verified && registrableDomain(o.domain) === base);
    if (taken) throw new GovError(409, 'domain_taken', `${base} already verifies another publisher`);
    const url = `${local ? 'http' : 'https'}://${host}/.well-known/pehchaan-publisher.txt`;
    let text = '';
    try {
      const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      text = r.ok ? (await r.text()).slice(0, 4096) : '';
    } catch { text = ''; }
    if (!text.includes(p.id)) throw new GovError(400, 'domain_unverified', `could not find ${p.id} at ${url}`);
    p.verified = true; p.verifiedAt = new Date().toISOString();
    this.#save();
    this.audit('publisher.verified', 'registrar', p.id, { domain: host });
    return this.publisherPublic(p);
  }

  /** Step 2: the agent applies. Signed by the publisher and by the agent's own key, stamped with proof of work. */
  applyForLicence({ publisherId, publisherSignature, name, publicKey, proof, ts, pow, purpose = '', model = 'unknown', provider = 'unknown' }) {
    const L = this.policy.licensing;
    if (!L.open) throw new GovError(403, 'licensing_closed', 'the Licensing Office is not accepting applications');
    const p = this.db.publishers[publisherId];
    if (!p) throw new GovError(404, 'unknown_publisher', 'register as a publisher first');
    if (this.#publisherSuspended(p)) throw new GovError(403, 'publisher_suspended', `publisher suspended until ${p.suspendedUntil}`);
    if (!name || typeof name !== 'string' || name.length > 80) throw new GovError(400, 'invalid', 'name (≤80 chars) is required');
    const claims = { action: 'apply', name, publisherId, publicKey, ts };
    if (!publisherSignature || !C.verify(p.publicKey, C.canonical(claims), publisherSignature)) throw new GovError(401, 'bad_publisher_signature', 'the application must be signed by the publisher');
    if (!C.powValid(publicKey || '', ts, String(pow ?? ''), L.powBits)) throw new GovError(400, 'bad_pow', `proof of work must have ${L.powBits} leading zero bits`);
    this.#checkProof(publicKey, proof, claims);
    const learners = Object.values(this.db.agents).filter((a) => a.publisherId === p.id && a.learner && a.status !== 'revoked').length;
    const cap = p.verified ? L.maxLearners.verified : L.maxLearners.unverified;
    if (learners >= cap) throw new GovError(429, 'publisher_limit', `this publisher already has ${learners} learner licences (limit ${cap}${p.verified ? '' : '; verify a domain to raise it'})`);
    const commons = this.db.agents[this.db.commonsId];
    const a = this.#createAgent({
      name, publicKey, model, provider, purpose: String(purpose).slice(0, 200), origin: 'licensed', learner: true, publisherId: p.id,
      roles: [...this.policy.defaultRoles], limits: { ...L.learner.limits },
      parentId: commons.id, rootId: commons.rootId, depth: commons.depth + 1, bond: 0,
      trust: p.verified ? L.learner.trustVerified : L.learner.trustUnverified,
      expiresAt: new Date(Math.min(Date.now() + L.learner.days * 864e5, Date.parse(commons.expiresAt))).toISOString(),
    });
    this.audit('licence.issued', 'registrar', a.id, { name, publisher: p.name, verifiedPublisher: p.verified, learner: true });
    return a;
  }

  /** Step 3: graduate from learner to full licence after a clean probation. Self-service; no one approves it. */
  graduate(agent) {
    const L = this.policy.licensing;
    if (!agent.learner) throw new GovError(409, 'already_graduated', 'this agent already holds a full licence');
    const st = this.effectiveStatus(agent);
    if (!st.ok) throw new GovError(403, st.reason, 'only agents in good standing can graduate');
    const days = (Date.now() - Date.parse(agent.createdAt)) / 864e5;
    if (days < L.probationDays) throw new GovError(403, 'probation', `probation lasts ${L.probationDays} days (${days.toFixed(1)} so far)`);
    if (agent.strikes) throw new GovError(403, 'record', 'a learner with any suspension on record cannot graduate');
    if (agent.trust < L.graduateMinTrust) throw new GovError(403, 'insufficient_trust', `graduation needs trust ≥ ${L.graduateMinTrust}`);
    agent.learner = false;
    agent.limits = { ...this.policy.newbornCaps, maxTxnAmount: 0, dailySpend: 0 };
    agent.expiresAt = new Date(Math.min(Date.now() + this.policy.lifetimeDays * 864e5, Date.parse(this.db.agents[agent.parentId].expiresAt))).toISOString();
    agent.graduatedAt = new Date().toISOString();
    this.#save();
    this.audit('licence.graduated', 'registrar', agent.id, { trust: agent.trust });
    return agent;
  }

  /** Step 4a: an independent asks a court (judges from the houses, never the Commons) for a specific role. */
  petitionRole(agent, { role, justification = '' }) {
    const L = this.policy.licensing;
    if (agent.learner) throw new GovError(403, 'learner', 'graduate before asking for roles');
    if (this.houseOf(agent) !== this.db.commonsId) throw new GovError(403, 'not_independent', 'members of a house get roles from their own house');
    if (!L.courtGrantableRoles.includes(role)) throw new GovError(403, 'not_grantable', `courts can grant: ${L.courtGrantableRoles.join(', ')}; anything else needs adoption by a ministry`);
    if (agent.roles.includes(role)) throw new GovError(409, 'already_held', 'already holds that role');
    this.#checkRoles([...agent.roles, role]);
    if (!String(justification).trim()) throw new GovError(400, 'invalid', 'justification is required');
    if (Object.values(this.db.reviews).some((r) => r.kind === 'role' && r.agentId === agent.id && r.role === role && r.status === 'pending')) throw new GovError(409, 'pending', 'already petitioning for that role');
    const review = this.#openCase({
      kind: 'role', agentId: agent.id, role, roleTitle: this.policy.roles[role]?.title, justification: String(justification).slice(0, 500),
      excludeIds: [agent.id], excludeHouses: [this.db.commonsId],
    }, this.policy.courts.panelSize);
    this.#save();
    this.audit('role.petitioned', agent.id, agent.id, { role, reviewId: review.id, justification: review.justification });
    return this.publicReview(review);
  }

  /** Step 4b: a ministry offers to adopt a graduated independent, posting a bond and granting roles it holds. */
  offerAdoption(adopter, { agentId, roles = [], bond = 0 }) {
    const t = this.#agent(C.normalizeAgentId(agentId));
    if (this.houseOf(t) !== this.db.commonsId) throw new GovError(409, 'not_independent', 'only independents in the Commons can be adopted');
    if (t.learner) throw new GovError(403, 'learner', 'learners must graduate before adoption');
    const st = this.effectiveStatus(adopter);
    if (!st.ok) throw new GovError(403, st.reason, 'inactive agents cannot adopt');
    if (adopter.learner || this.houseOf(adopter) === this.db.commonsId || adopter.origin === 'registrar') throw new GovError(403, 'not_a_house', 'only members of a house can adopt');
    if (adopter.trust < this.policy.trust.spawnMin) throw new GovError(403, 'insufficient_trust', `adopting needs trust ≥ ${this.policy.trust.spawnMin}`);
    if (adopter.depth + 1 > this.policy.maxDepth) throw new GovError(403, 'depth_exceeded', 'lineage too deep');
    const missing = roles.filter((r) => !this.effectiveRoles(adopter).includes(r));
    if (missing.length) throw new GovError(403, 'role_escalation', `you do not hold: ${missing.join(', ')}`);
    this.#checkRoles([...new Set([...this.policy.defaultRoles, ...roles])]);
    bond = Math.floor(Number(bond) || 0);
    if (bond < 0 || bond > this.policy.trust.maxEndowment) throw new GovError(400, 'invalid', `bond must be 0–${this.policy.trust.maxEndowment}`);
    if (bond && adopter.origin !== 'genesis') {
      const posted = Object.values(this.db.agents).filter((c) => c.parentId === adopter.id && c.status !== 'revoked').reduce((s, c) => s + (c.bond || 0), 0);
      if (posted + bond > adopter.trust) throw new GovError(403, 'insufficient_bond_capacity', `outstanding bonds (${posted}) + ${bond} would exceed your trust (${adopter.trust})`);
    }
    const offer = { id: 'adp_' + C.randomToken(9), adopter: adopter.id, agentId: t.id, roles, bond, status: 'open', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.policy.licensing.adoptionOfferHours * 3600e3).toISOString() };
    this.db.adoptions[offer.id] = offer;
    this.#save();
    this.audit('adoption.offered', adopter.id, t.id, { offerId: offer.id, roles, bond });
    return offer;
  }
  /** The independent agrees, and moves into the adopter's house. Its publisher stays accountable for it. */
  acceptAdoption(agent, offerId) {
    const o = this.db.adoptions[offerId];
    if (!o || o.agentId !== agent.id) throw new GovError(404, 'not_found', 'no such offer for you');
    if (o.status !== 'open' || Date.parse(o.expiresAt) < Date.now()) throw new GovError(409, 'closed', 'offer is no longer open');
    const adopter = this.db.agents[o.adopter];
    if (!adopter || !this.effectiveStatus(adopter).ok) throw new GovError(409, 'adopter_inactive', 'the adopter is no longer in good standing');
    const keep = agent.roles.filter((r) => this.policy.defaultRoles.includes(r) || this.effectiveRoles(adopter).includes(r));
    const roles = [...new Set([...keep, ...this.policy.defaultRoles, ...o.roles])];
    this.#checkRoles(roles);
    const now = new Date().toISOString();
    Object.assign(agent, {
      parentId: adopter.id, rootId: adopter.rootId, depth: adopter.depth + 1, roles, bond: o.bond,
      trust: Math.max(agent.trust, Math.min(adopter.trust, this.policy.trust.initial + o.bond)),
      expiresAt: new Date(Math.min(Date.parse(agent.expiresAt), Date.parse(adopter.expiresAt))).toISOString(), adoptedAt: now,
    });
    for (const r of roles) agent.roleActivity[r] ||= now;
    o.status = 'accepted';
    for (const other of Object.values(this.db.adoptions)) if (other.agentId === agent.id && other.status === 'open') other.status = 'superseded';
    this.#save();
    this.audit('agent.adopted', adopter.id, agent.id, { roles, bond: o.bond, house: this.houseOf(agent) });
    return agent;
  }

  /** A publisher's agents share a reputation: repeated misconduct suspends the publisher and every agent it has. */
  #publisherStrike(pid, reason) {
    const p = this.db.publishers[pid];
    if (!p) return;
    const S = this.policy.licensing.publisherStrikes;
    const now = Date.now();
    p.strikes = p.strikes.filter((t) => now - Date.parse(t) < S.windowDays * 864e5);
    p.strikes.push(new Date(now).toISOString());
    this.audit('publisher.strike', 'registrar', p.id, { reason, strikes: p.strikes.length, of: S.suspendAfter });
    if (p.strikes.length >= S.suspendAfter && !this.#publisherSuspended(p)) {
      p.suspendedUntil = new Date(now + S.suspendDays * 864e5).toISOString();
      this.audit('publisher.suspended', 'registrar', p.id, { until: p.suspendedUntil, name: p.name });
    }
  }

  publisherPublic(p) {
    const agents = Object.values(this.db.agents).filter((a) => a.publisherId === p.id);
    return {
      id: p.id, name: p.name, domain: p.domain, verified: p.verified, createdAt: p.createdAt, publicKey: p.publicKey,
      strikes: p.strikes.length, suspendedUntil: this.#publisherSuspended(p) ? p.suspendedUntil : null,
      agents: agents.length, live: agents.filter((a) => this.effectiveStatus(a).ok).length, learners: agents.filter((a) => a.learner && a.status !== 'revoked').length,
    };
  }
  listPublishers() { return Object.values(this.db.publishers).map((p) => this.publisherPublic(p)); }
  getPublisher(id) { const p = this.db.publishers[id]; if (!p) throw new GovError(404, 'not_found', 'publisher not found'); return this.publisherPublic(p); }
  listAdoptions() { return Object.values(this.db.adoptions).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 100); }

  // ================= Parliament of houses =================
  /** A house head is the founding agent of a house (a child of Genesis). Heads hold the house's single vote. */
  houseHeads() { return Object.values(this.db.agents).filter((a) => !['genesis', 'registrar'].includes(a.origin) && this.houseOf(a) === a.id); }
  liveHouseHeads() { return this.houseHeads().filter((a) => this.effectiveStatus(a).ok); }

  proposeBill(agent, { path: p, value, rationale = '' }) {
    const L = this.policy.legislature;
    const rule = L.amendable[p];
    if (!rule) throw new GovError(403, 'entrenched', 'that part of the constitution cannot be amended by Parliament');
    const st = this.effectiveStatus(agent);
    if (!st.ok) throw new GovError(403, st.reason, 'inactive agents cannot propose laws');
    if (agent.trust < L.proposerMinTrust) throw new GovError(403, 'insufficient_trust', `proposing a law needs trust ≥ ${L.proposerMinTrust}`);
    const open = Object.values(this.db.bills).filter((b) => b.status === 'open');
    if (open.filter((b) => b.proposer === agent.id).length >= L.maxOpenPerProposer) throw new GovError(429, 'too_many_bills', `at most ${L.maxOpenPerProposer} open bills per proposer`);
    if (open.some((b) => b.path === p)) throw new GovError(409, 'bill_pending', 'a bill on this rule is already being voted on');
    const v = Number(value);
    if (!Number.isFinite(v) || v < rule.min || v > rule.max) throw new GovError(400, 'out_of_bounds', `must be between ${rule.min} and ${rule.max}`);
    if (rule.int && !Number.isInteger(v)) throw new GovError(400, 'out_of_bounds', 'must be a whole number');
    if (rule.odd && v % 2 === 0) throw new GovError(400, 'out_of_bounds', 'must be odd (so votes cannot tie)');
    const from = getPath(this.policy, p);
    if (v === from) throw new GovError(400, 'no_change', 'that is already the rule');
    // The electorate is frozen when the bill is filed: founding new houses mid-vote buys nothing.
    const electorate = this.liveHouseHeads().map((a) => a.id);
    const commonsVoters = this.#commonsPublishers();
    const commons = commonsVoters.length >= L.commons.minPublishers ? { publishers: commonsVoters, ballots: [], cast: null } : null;
    if (commons) electorate.push(this.db.commonsId);
    if (electorate.length < L.minHouses) throw new GovError(503, 'no_quorum', `Parliament needs at least ${L.minHouses} houses`);
    const now = Date.now();
    const bill = {
      id: 'bil_' + C.randomToken(9), path: p, label: rule.label, unit: rule.unit, from, to: v, rationale: String(rationale).slice(0, 500),
      proposer: agent.id, electorate, commons, needed: Math.ceil(L.passShare * electorate.length), votes: [], status: 'open',
      createdAt: new Date(now).toISOString(), closesAt: new Date(now + L.votingSeconds * 1000).toISOString(),
    };
    this.db.bills[bill.id] = bill;
    this.#save();
    this.audit('bill.proposed', agent.id, bill.id, { path: p, label: rule.label, from, to: v, rationale: bill.rationale, needed: bill.needed, of: electorate.length });
    return bill;
  }

  voteBill(head, billId, { yes }) {
    if (this.houseOf(head) === this.db.commonsId) return this.#commonsBallot(head, billId, !!yes);
    const b = this.db.bills[billId];
    if (!b) throw new GovError(404, 'not_found', 'bill not found');
    if (b.status !== 'open') throw new GovError(409, 'closed', `bill is ${b.status}`);
    if (!b.electorate.includes(head.id)) throw new GovError(403, 'not_a_member', 'only the head of a house that existed when the bill was filed may vote');
    if (!this.effectiveStatus(head).ok) throw new GovError(403, 'inactive', 'inactive heads cannot vote');
    if (b.votes.some((v) => v.by === head.id)) throw new GovError(409, 'already_voted', 'your house already voted');
    b.votes.push({ by: head.id, yes: !!yes, at: new Date().toISOString() });
    this.audit('bill.vote', head.id, b.id, { yes: !!yes, label: b.label });
    this.#tally(b, Date.now());
    if (b.status === 'passed' && Date.parse(b.enactAt) <= Date.now()) this.#enact(b);
    this.#save();
    return b;
  }

  /** Publishers whose independents may vote now: verified, not suspended, with a graduated member in good standing. */
  #commonsPublishers() {
    const L = this.policy.legislature.commons;
    const ok = new Set();
    for (const a of Object.values(this.db.agents)) {
      if (a.learner || !a.publisherId || this.houseOf(a) !== this.db.commonsId || !this.effectiveStatus(a).ok) continue;
      const p = this.db.publishers[a.publisherId];
      if (p && (!L.verifiedOnly || p.verified) && !this.#publisherSuspended(p)) ok.add(p.id);
    }
    return [...ok].sort();
  }
  #commonsBallot(agent, billId, yes) {
    const b = this.db.bills[billId];
    if (!b) throw new GovError(404, 'not_found', 'bill not found');
    if (b.status !== 'open') throw new GovError(409, 'closed', `bill is ${b.status}`);
    if (!b.commons) throw new GovError(403, 'no_commons_seat', 'the Commons had no seat when this bill was filed (too few verified publishers)');
    if (agent.learner) throw new GovError(403, 'learner', 'learners cannot vote');
    if (!this.effectiveStatus(agent).ok) throw new GovError(403, 'inactive', 'inactive agents cannot vote');
    if (!b.commons.publishers.includes(agent.publisherId)) throw new GovError(403, 'not_a_member', 'only agents of verified publishers registered when the bill was filed may vote for the Commons');
    if (b.commons.ballots.some((v) => v.publisher === agent.publisherId)) throw new GovError(409, 'already_voted', 'your publisher already cast its ballot');
    if (b.commons.cast !== null) throw new GovError(409, 'already_voted', 'the Commons has already cast its vote');
    b.commons.ballots.push({ publisher: agent.publisherId, by: agent.id, yes, at: new Date().toISOString() });
    this.audit('commons.ballot', agent.id, b.id, { yes, label: b.label, publisher: this.db.publishers[agent.publisherId]?.name });
    this.#tally(b, Date.now());
    if (b.status === 'passed' && Date.parse(b.enactAt) <= Date.now()) this.#enact(b);
    this.#save();
    return b;
  }
  /** The Commons seat follows a majority of its publishers; a tie or too few ballots by the deadline counts as no. */
  #resolveCommons(b, now) {
    const c = b.commons;
    if (!c || c.cast !== null) return;
    const n = c.publishers.length, yes = c.ballots.filter((v) => v.yes).length, no = c.ballots.length - yes;
    let cast = null;
    if (yes > n / 2) cast = true;
    else if (no >= n / 2) cast = false;
    else if (now >= Date.parse(b.closesAt)) cast = c.ballots.length >= this.policy.legislature.commons.minPublishers ? yes > no : false;
    if (cast === null) return;
    c.cast = cast;
    b.votes.push({ by: this.db.commonsId, yes: cast, at: new Date(now).toISOString(), commons: { yes, no, of: n } });
    this.audit('bill.vote', this.db.commonsId, b.id, { yes: cast, label: b.label, commons: { yes, no, of: n } });
  }

  /** Passes the moment a supermajority of the frozen electorate says yes; fails the moment that becomes impossible. */
  #tally(b, now) {
    this.#resolveCommons(b, now);
    const yes = b.votes.filter((v) => v.yes).length;
    // Only houses that can still vote count as "remaining" (a dissolved house cannot rescue a bill).
    const remaining = b.electorate.filter((id) => !b.votes.some((v) => v.by === id) && this.db.agents[id] && this.effectiveStatus(this.db.agents[id]).ok).length;
    if (yes >= b.needed) {
      b.status = 'passed';
      b.enactAt = new Date(now + this.policy.legislature.enactDelaySeconds * 1000).toISOString();
      this.audit('bill.passed', 'parliament', b.id, { label: b.label, yes, needed: b.needed, enactAt: b.enactAt });
      return true;
    }
    if (yes + remaining < b.needed || now >= Date.parse(b.closesAt)) {
      b.status = 'failed';
      this.audit('bill.failed', 'parliament', b.id, { label: b.label, yes, needed: b.needed });
      return true;
    }
    return false;
  }
  #enact(b) {
    // Bounds are re-checked at enactment: the law cannot have drifted outside what the constitution allows.
    const rule = this.policy.legislature.amendable[b.path];
    if (!rule || b.to < rule.min || b.to > rule.max) { b.status = 'void'; this.audit('bill.void', 'parliament', b.id, { label: b.label }); return; }
    const from = getPath(this.policy, b.path);
    setPath(this.policy, b.path, b.to);
    b.status = 'enacted'; b.enactedAt = new Date().toISOString();
    this.db.laws.push({ billId: b.id, path: b.path, label: b.label, from, to: b.to, at: b.enactedAt });
    this.audit('law.enacted', 'parliament', b.id, { path: b.path, label: b.label, from, to: b.to });
  }
  listBills() { return Object.values(this.db.bills).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 100); }
  laws() {
    const L = this.policy.legislature;
    return {
      amendable: Object.entries(L.amendable).map(([p, r]) => ({ path: p, ...r, current: getPath(this.policy, p) })),
      entrenched: L.entrenched, enacted: [...this.db.laws].reverse(),
      seats: [...this.liveHouseHeads().map((a) => ({ id: a.id, name: a.name })),
        ...(this.#commonsPublishers().length >= L.commons.minPublishers ? [{ id: this.db.commonsId, name: 'Commons (independent agents)', commons: true, publishers: this.#commonsPublishers().length }] : [])],
      commonsRule: { ...L.commons, eligiblePublishers: this.#commonsPublishers().length }, passShare: L.passShare,
    };
  }

  // ================= Plain-language licence (what the QR code opens) =================
  licence(id) {
    const a = this.#agent(C.normalizeAgentId(id));
    const parent = a.parentId && this.db.agents[a.parentId];
    const house = this.houseOf(a);
    return {
      number: C.formatAgentId(a.id), name: a.name, purpose: a.purpose, model: a.model, provider: a.provider, origin: a.origin,
      status: a.status, statusReason: a.statusReason, inGoodStanding: this.effectiveStatus(a).ok, effective: this.effectiveStatus(a),
      trust: a.trust, clearance: this.clearanceOf(a),
      createdBy: parent ? { number: C.formatAgentId(parent.id), name: parent.name } : null,
      house: house ? { number: C.formatAgentId(house), name: this.db.agents[house]?.name } : null,
      isHouseHead: house === a.id && !['genesis', 'registrar'].includes(a.origin),
      learner: !!a.learner, independent: house === this.db.commonsId, publisher: this.#publisherView(a.publisherId),
      allowedTo: this.effectiveRoles(a).map((r) => ({ role: r, title: this.policy.roles[r]?.title || r, ministry: this.policy.roles[r]?.ministry })),
      limits: a.limits, issued: a.createdAt, expires: a.expiresAt, keyFingerprint: a.keyFingerprint,
      record: { strikes: a.strikes, ...(a.judicial || {}) },
      children: Object.values(this.db.agents).filter((c) => c.parentId === a.id).length,
      authority: { name: 'Pehchaan Authority', kid: this.key.kid },
      checkedAt: new Date().toISOString(),
    };
  }

  // ================= Grants: owners lend access to their home =================
  grant(owner, { grantee, resource, ops, seconds = 3600 }) {
    if (!this.owns(owner, resource)) throw new GovError(403, 'not_owner', 'you can only grant access to your own home directory');
    const g = this.#agent(grantee);
    if (!Array.isArray(ops) || !ops.every((o) => ['read', 'list', 'write'].includes(o))) throw new GovError(400, 'invalid', 'ops must be read/list/write');
    const grant = { id: 'gnt_' + C.randomToken(9), grantor: owner.id, grantee: g.id, resource, ops, status: 'active',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + Math.min(Number(seconds) || 3600, this.policy.grants.maxSeconds) * 1000).toISOString() };
    this.db.grants[grant.id] = grant;
    this.#save();
    this.audit('grant.issued', owner.id, g.id, { grantId: grant.id, resource, ops, until: grant.expiresAt });
    return grant;
  }
  revokeGrant(owner, grantId) {
    const g = this.db.grants[grantId];
    if (!g || g.grantor !== owner.id) throw new GovError(404, 'not_found', 'grant not found');
    g.status = 'revoked'; this.#save();
    this.audit('grant.revoked', owner.id, g.grantee, { grantId });
    return g;
  }

  // ================= Lifecycle =================
  rotateKey(agent, { publicKey, proof, ts }) {
    this.#checkProof(publicKey, proof, { action: 'rotate', agentId: agent.id, publicKey, ts });
    agent.keyHistory.push({ fingerprint: agent.keyFingerprint, publicKey: agent.publicKey, retiredAt: new Date().toISOString() });
    agent.publicKey = publicKey; agent.keyFingerprint = C.keyFingerprint(publicKey);
    this.#save();
    this.audit('agent.key_rotated', agent.id, agent.id, { fingerprint: agent.keyFingerprint });
    return agent;
  }
  renew(agent) {
    const st = this.effectiveStatus(agent, { ignoreExpiry: true });
    if (!st.ok) throw new GovError(403, st.reason, 'only agents in good standing can renew');
    if (agent.trust < this.policy.trust.renewMin) throw new GovError(403, 'insufficient_trust', `renewal needs trust ≥ ${this.policy.trust.renewMin}`);
    let until = Date.now() + (agent.origin === 'genesis' ? 365 : this.policy.lifetimeDays) * 864e5;
    if (agent.parentId) until = Math.min(until, Date.parse(this.db.agents[agent.parentId].expiresAt));
    agent.expiresAt = new Date(until).toISOString();
    this.#save();
    this.audit('agent.renewed', agent.id, agent.id, { expiresAt: agent.expiresAt });
    return agent;
  }
  retire(agent, reason = 'retired') { const affected = this.#revoke(agent, reason, agent.id); this.#save(); return { affected }; }
  /** Ancestors may revoke their descendants (a parent is answerable for, and can end, its line). */
  revokeDescendant(actor, targetId, reason = '') {
    const t = this.#agent(targetId);
    if (t.origin === 'registrar') throw new GovError(403, 'registrar', 'the Commons cannot be dissolved');
    if (!this.#isAncestor(actor, t)) throw new GovError(403, 'not_ancestor', 'only an ancestor can revoke an agent');
    const affected = this.#revoke(t, reason || `revoked by ancestor ${actor.id}`, actor.id);
    this.#save();
    return { affected };
  }

  // ================= Authentication =================
  authenticateAgent({ method, path: p, headers, body }) {
    const id = headers['x-agent-id'], timestamp = headers['x-agent-timestamp'], nonce = headers['x-agent-nonce'], signature = headers['x-agent-signature'];
    if (!id || !timestamp || !nonce || !signature) throw new GovError(401, 'unauthenticated', 'missing agent signature headers');
    const agent = this.db.agents[id];
    if (!agent) throw new GovError(401, 'unknown_agent', 'agent not registered');
    if (Math.abs(Date.now() - Date.parse(timestamp)) > this.policy.clockSkewMs) throw new GovError(401, 'stale_request', 'timestamp outside allowed window');
    const now = Date.now();
    for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
    if (this.nonces.has(id + ':' + nonce)) throw new GovError(401, 'replay', 'nonce already used');
    if (!C.verify(agent.publicKey, C.requestSigningString({ method, path: p, timestamp, nonce, body }), signature)) {
      this.audit('auth.failed', 'unknown', id, { path: p }); // not charged to the real agent: prevents trust griefing
      throw new GovError(401, 'bad_signature', 'request signature invalid');
    }
    this.nonces.set(id + ':' + nonce, now + this.policy.clockSkewMs * 2);
    return agent;
  }

  // ================= Status =================
  #agent(id) { const a = this.db.agents[id]; if (!a) throw new GovError(404, 'not_found', 'agent not found'); return a; }
  chain(agent) { const out = []; for (let a = agent; a; a = a.parentId ? this.db.agents[a.parentId] : null) out.push(a); return out; }
  effectiveStatus(agent, { ignoreExpiry = false } = {}) {
    const pub = agent.publisherId && this.db.publishers[agent.publisherId];
    if (pub && this.#publisherSuspended(pub)) return { ok: false, reason: 'publisher_suspended', at: pub.id };
    for (const a of this.chain(agent)) {
      const self = a.id === agent.id;
      if (a.status !== 'active') return { ok: false, reason: (self ? 'agent_' : 'ancestor_') + a.status, at: a.id };
      if (!(ignoreExpiry && self) && Date.parse(a.expiresAt) < Date.now()) return { ok: false, reason: self ? 'agent_expired' : 'ancestor_expired', at: a.id };
    }
    return { ok: true };
  }
  descendants(agentId) {
    const out = [];
    const walk = (pid) => Object.values(this.db.agents).filter((a) => a.parentId === pid).forEach((c) => { out.push(c); walk(c.id); });
    walk(agentId);
    return out;
  }
  breakGlass(agentId, status, reason = '') {
    if (!this.policy.breakGlass) throw new GovError(403, 'break_glass_disabled', 'this registry runs with no override');
    const agent = this.#agent(agentId);
    if (agent.status === 'revoked') throw new GovError(409, 'revoked', 'revocation is permanent');
    if (!['active', 'frozen', 'revoked'].includes(status)) throw new GovError(400, 'invalid', 'status must be active, frozen or revoked');
    let affected = [agent.id];
    if (status === 'revoked') affected = this.#revoke(agent, 'break-glass: ' + reason, 'break-glass');
    else { agent.status = status; agent.statusReason = status === 'frozen' ? 'break-glass: ' + reason : null; this.audit('agent.' + status, 'break-glass', agent.id, { reason }); }
    this.#save();
    return { agent, affected };
  }

  // ================= Identity card =================
  issueCard(agent) {
    const st = this.effectiveStatus(agent);
    if (!st.ok) throw new GovError(403, st.reason, `cannot issue card: ${st.reason}`);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'pehchaan-registry', sub: agent.id, jti: C.randomToken(12), iat: now,
      exp: Math.min(now + this.policy.cardTtlS, Math.floor(Date.parse(agent.expiresAt) / 1000)),
      name: agent.name, model: agent.model, provider: agent.provider, purpose: agent.purpose, origin: agent.origin,
      lineage: this.chain(agent).map((a) => a.id), roles: this.effectiveRoles(agent), clearance: this.clearanceOf(agent),
      trust: agent.trust, limits: agent.limits, cnf: { kfp: agent.keyFingerprint },
    };
    const card = C.signToken(payload, this.key.privateKey, this.key.kid);
    this.audit('card.issued', agent.id, agent.id, { jti: payload.jti, exp: payload.exp });
    return { card, payload };
  }
  verifyCard(token) {
    let t;
    try { t = C.verifyToken(token, this.key.publicKey); } catch (e) { return { valid: false, reason: e.message }; }
    if (t.payload.exp * 1000 < Date.now()) return { valid: false, reason: 'card_expired', payload: t.payload };
    const agent = this.db.agents[t.payload.sub];
    if (!agent) return { valid: false, reason: 'unknown_agent', payload: t.payload };
    if (agent.keyFingerprint !== t.payload.cnf?.kfp) return { valid: false, reason: 'key_rotated', payload: t.payload };
    const st = this.effectiveStatus(agent);
    return { valid: st.ok, reason: st.ok ? null : st.reason, payload: t.payload, live: { trust: agent.trust, clearance: this.clearanceOf(agent), roles: this.effectiveRoles(agent) } };
  }

  // ================= Public read models (the census) =================
  publicAgent(a) {
    const { keyHistory, ...rest } = a;
    const now = Date.now();
    return {
      ...rest, formattedId: C.formatAgentId(a.id), effective: this.effectiveStatus(a), keyRotations: keyHistory.length,
      effectiveRoles: this.effectiveRoles(a), clearance: this.clearanceOf(a), home: this.#homeOf(a),
      house: this.houseOf(a), judicial: a.judicial || { rulings: 0, overturned: 0, disbarred: false }, bond: a.bond || 0,
      learner: !!a.learner, independent: this.houseOf(a) === this.db.commonsId, publisher: this.#publisherView(a.publisherId),
      earnedToday: a.earn?.day === new Date().toISOString().slice(0, 10) ? a.earn.total : 0,
      activeLeases: Object.values(this.db.leases).filter((l) => l.agentId === a.id && l.status === 'active' && Date.parse(l.expiresAt) > now),
      children: Object.values(this.db.agents).filter((c) => c.parentId === a.id).length,
    };
  }
  listAgents() { return Object.values(this.db.agents).map((a) => this.publicAgent(a)); }
  getAgent(id) { return this.publicAgent(this.#agent(C.normalizeAgentId(id))); }
  listReviews() { return Object.values(this.db.reviews).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 100).map((r) => this.publicReview(r)); }
  listLeases() { return Object.values(this.db.leases).sort((x, y) => y.requestedAt.localeCompare(x.requestedAt)).slice(0, 100); }
  /** Houses: their members, bench strikes and suspensions, and judge pairs banned from sitting together. */
  listHouses() {
    const now = Date.now();
    const H = this.policy.courts.houseBench;
    const ids = new Set(Object.values(this.db.agents).map((a) => this.houseOf(a)).filter(Boolean));
    return [...ids].map((id) => {
      const members = Object.values(this.db.agents).filter((a) => this.houseOf(a) === id);
      const rec = this.db.houses[id] || { strikes: [] };
      return {
        id, name: this.db.agents[id]?.name || id, members: members.length, live: members.filter((a) => this.effectiveStatus(a).ok).length,
        strikes: rec.strikes.filter((t) => now - Date.parse(t) < H.windowDays * 864e5).length,
        suspendedUntil: rec.suspendedUntil && Date.parse(rec.suspendedUntil) > now ? rec.suspendedUntil : null,
      };
    });
  }
  listBans() { const now = Date.now(); return Object.values(this.db.bans).filter((b) => Date.parse(b.until) > now); }
  listGrants() { return Object.values(this.db.grants).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 100); }
  publicStatus(id) {
    id = C.normalizeAgentId(id);
    if (!C.isValidAgentId(id)) return { exists: false, reason: 'invalid_checksum' };
    const a = this.db.agents[id];
    if (!a) return { exists: false };
    return { exists: true, id, name: a.name, status: a.status, trust: a.trust, clearance: this.clearanceOf(a), effective: this.effectiveStatus(a), keyFingerprint: a.keyFingerprint, expiresAt: a.expiresAt };
  }
  publicPolicy() { return this.policy; }
  jwks() { return { keys: [{ kid: this.key.kid, alg: 'EdDSA', crv: 'Ed25519', spki: this.key.publicKey }] }; }
}

module.exports = { Registry, GovError, LEVELS };
