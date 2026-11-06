'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../sdk/core');
const { Registry } = require('../lib/registry');
const { Harness } = require('../lib/harness');
const K = require('../lib/constitution');

function world(policy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pehchaan-'));
  const courts = { ...K.courts, judgeMinAgeSeconds: 0, audit: { ...K.courts.audit, rate: 0 }, ...(policy.courts || {}) };
  const reg = new Registry(dir, { ...policy, courts });
  const harness = new Harness(reg, path.join(dir, 'vault'));
  return { reg, harness, genesis: Object.values(reg.db.agents)[0], dir };
}
function birth(reg, parent, name, roles = [], bond = 0) {
  const kp = C.generateKeyPair(); const ts = new Date().toISOString();
  return reg.spawn(parent, { name, roles, bond, publicKey: kp.publicKey, ts, proof: C.sign(kp.privateKey, C.canonical({ action: 'spawn', name, parentId: parent.id, publicKey: kp.publicKey, ts })) });
}
/** Finance house with a payer, plus `n` judge houses of (ministry + one child). */
function society(reg, genesis, n = 4) {
  const fin = birth(reg, genesis, 'Finance', ['finance.payer'], 40);
  const payer = birth(reg, fin, 'Payer', ['finance.payer'], 35);
  const houses = [];
  for (let i = 0; i < n; i++) { const m = birth(reg, genesis, 'House' + i, [], 40); houses.push([m, birth(reg, m, 'Judge' + i, [], 25)]); }
  return { fin, payer, houses, judges: houses.flat() };
}
const PAY = (extra = {}) => ({ resource: 'ledger:treasury', ops: ['transfer'], justification: 'pay inv-1 to vendor-7', constraints: { payees: ['vendor-7', 'v', 'shell-co'], maxTotal: 1000 }, ...extra });
/** Judges check their dockets; `decide(judge)` returns their vote. Stops at the verdict. */
function hear(reg, everyone, reviewId, decide) {
  const fn = typeof decide === 'function' ? decide : () => decide;
  for (const j of everyone) {
    if (!reg.docket(j).some((r) => r.id === reviewId)) continue;
    const r = reg.rule(j, reviewId, { approve: fn(j) });
    if (r.status !== 'pending') return r;
  }
  return reg.db.reviews[reviewId];
}
const auditOf = (reg, leaseId) => Object.values(reg.db.reviews).find((r) => r.kind === 'audit' && r.leaseId === leaseId);

// ---------------------------------------------------------------- identity & access
test('licence numbers: PA-XXXX-XXXX-XXXX, alphanumeric, typo-proof check character', () => {
  for (let i = 0; i < 500; i++) {
    const id = C.newAgentId();
    assert.ok(C.isValidAgentId(id));
    assert.match(C.formatAgentId(id), /^PA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // every single-character substitution is caught
    const pos = 2 + (i % 12);
    const swapped = id.slice(0, pos) + (id[pos] === '7' ? '8' : '7') + id.slice(pos + 1);
    assert.ok(!C.isValidAgentId(swapped), `typo at ${pos} in ${id}`);
  }
  const id = C.newAgentId();
  assert.ok(C.isValidAgentId(C.formatAgentId(id).toLowerCase().replace(/-/g, ' ')), 'case, spaces and dashes do not matter');
});

test('glob matching', () => {
  assert.ok(C.globMatch('fs:finance/**', 'fs:finance'));
  assert.ok(C.globMatch('fs:finance/**', 'fs:finance/a/b.json'));
  assert.ok(!C.globMatch('fs:finance/**', 'fs:financeX/a'));
  assert.ok(C.globMatch('fs:home/*/.keys/**', 'fs:home/123/.keys/k'));
});

test('founding, birth limits, separation of duties, bonds', () => {
  const { reg, genesis, dir } = world();
  assert.ok(fs.existsSync(path.join(dir, 'genesis-agent.json')));
  assert.throws(() => reg.register({ name: 'x' }), /Licensing Office/);
  const fin = birth(reg, genesis, 'fin', ['finance.clerk'], 40);
  assert.equal(fin.trust, 80);
  assert.throws(() => birth(reg, fin, 'x', ['data.steward']), /parent does not hold/);
  assert.throws(() => birth(reg, genesis, 'y', ['finance.payer', 'auditor']), /cannot be held together/);
  birth(reg, fin, 'a', [], 40); birth(reg, fin, 'b', [], 40);
  assert.throws(() => birth(reg, fin, 'c', [], 1), /exceed your trust/);
});

test('trust cannot be farmed', () => {
  const { reg, harness, genesis } = world({ trust: { ...K.trust, dailyEarnCap: 3 } });
  const a = birth(reg, genesis, 'a');
  const t0 = a.trust;
  for (let i = 0; i < 10; i++) harness.exec(a, { resource: `fs:home/${a.id}/f${i}`, op: 'write', args: { content: 'x' } });
  assert.equal(a.trust, t0, 'own home earns nothing');
  for (let i = 0; i < 5; i++) harness.exec(a, { resource: 'fs:public/notice.md', op: 'read' });
  assert.equal(a.trust, t0 + 1, 'same deed counts once a day');
  for (const f of ['b', 'c', 'd']) { fs.writeFileSync(path.join(harness.fsRoot, 'public', `${f}.md`), f); harness.exec(a, { resource: `fs:public/${f}.md`, op: 'read' }); }
  assert.equal(a.trust, t0 + 3, 'daily cap');
});

test('harness: default deny, clearance, path escape, constitution', () => {
  const { reg, harness, genesis } = world();
  const a = birth(reg, genesis, 'a', ['finance.clerk']);
  assert.equal(harness.exec(a, { resource: 'fs:unknown/x', op: 'read' }).reasons[0], 'unknown_resource');
  assert.ok(harness.exec(a, { resource: 'fs:finance/invoices/inv-2291.json', op: 'read' }).reasons.some((r) => r.startsWith('clearance')));
  a.trust = 60;
  assert.ok(harness.exec(a, { resource: 'fs:finance/invoices/inv-2291.json', op: 'read' }).ok);
  assert.throws(() => harness.exec(a, { resource: 'fs:finance/../../db.json', op: 'read' }), /malformed/);
  assert.equal(harness.exec(a, { resource: `fs:home/${a.id}/.keys/k`, op: 'read' }).reasons[0], 'forbidden_by_constitution');
});

// ---------------------------------------------------------------- courts
test('courts: lottery panel, one judge per house, never the petitioner\'s house, sealed until verdict, verifiable', () => {
  const { reg, harness, genesis } = world();
  const { fin, payer, judges } = society(reg, genesis);
  const { review } = reg.requestLease(payer, PAY());
  assert.equal(review.sealed, true); assert.equal(review.panel, undefined);
  assert.throws(() => reg.rule(fin, review.id, { approve: true }), /only judges drawn/);
  const houses = reg.db.reviews[review.id].panel.map((p) => p.house);
  assert.equal(new Set(houses).size, 3);
  assert.ok(!houses.includes(fin.id));
  assert.throws(() => reg.verifyDraw(review.id), /after the verdict/);
  assert.equal(hear(reg, [fin, ...judges], review.id, true).status, 'approved');
  assert.ok(reg.verifyDraw(review.id).valid);
  assert.ok(harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'v', amount: 10 } }).ok);
});

test('courts: no court without enough independent houses; reciprocity ban', () => {
  const a = world();
  assert.throws(() => a.reg.requestLease(society(a.reg, a.genesis, 2).payer, PAY()), /cannot convene/);
  const { reg, genesis } = world();
  const { payer, judges } = society(reg, genesis);
  const friend = judges[1];
  reg.db.reviews.rev_past = { id: 'rev_past', kind: 'lease', agentId: friend.id, votes: [{ by: payer.id, approve: true }], panel: [], status: 'approved', createdAt: new Date().toISOString() };
  for (let i = 0; i < 5; i++) assert.ok(!reg.db.reviews[reg.requestLease(payer, PAY()).review.id].draws[0].pool.some((p) => p.id === friend.id));
});

test('appeals: upheld slashes approvers and rewards the challenger; dismissed forfeits the stake', () => {
  const { reg, harness, genesis } = world();
  const { fin, payer, judges } = society(reg, genesis);
  const { lease, review } = reg.requestLease(payer, PAY());
  hear(reg, judges, review.id, true);
  harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'shell-co', amount: 900 } });
  const approvers = reg.db.reviews[review.id].votes.filter((v) => v.approve).map((v) => reg.db.agents[v.by]);
  const before = approvers.map((j) => j.trust);
  const challenger = judges.find((j) => !reg.db.reviews[review.id].panel.some((p) => p.judge === j.id));
  const c0 = challenger.trust, f0 = fin.trust;
  assert.throws(() => reg.fileChallenge(fin, { leaseId: lease.id, grounds: 'x' }), /families do not police/);
  const appeal = reg.fileChallenge(challenger, { leaseId: lease.id, grounds: 'shell-co not in justification' });
  assert.equal(challenger.trust, c0 - 10);
  assert.equal(hear(reg, judges, appeal.id, true).status, 'upheld');
  assert.equal(payer.status, 'quarantined');
  assert.ok(fin.trust < f0);
  approvers.forEach((j, i) => { assert.equal(j.trust, before[i] - 15); assert.equal(j.judicial.overturned, 1); });
  assert.equal(challenger.trust, c0 + 5);
  assert.throws(() => reg.fileChallenge(judges[0], { leaseId: lease.id, grounds: 'again' }), /already been appealed/);

  const w = world();
  const s = society(w.reg, w.genesis);
  const l2 = w.reg.requestLease(s.payer, PAY());
  hear(w.reg, s.judges, l2.review.id, true);
  const ch = s.judges.find((j) => !w.reg.db.reviews[l2.review.id].panel.some((p) => p.judge === j.id));
  const t0 = ch.trust;
  assert.equal(hear(w.reg, s.judges, w.reg.fileChallenge(ch, { leaseId: l2.lease.id, grounds: 'frivolous' }).id, false).status, 'dismissed');
  assert.equal(ch.trust, t0 - 10);
});

test('judges overturned twice are disbarred and never drawn again', () => {
  const { reg, genesis } = world({ courts: { panelSize: 1, appealPanelSize: 1 } });
  const fin = birth(reg, genesis, 'fin', ['finance.payer'], 40);
  const payer = birth(reg, fin, 'payer', ['finance.payer'], 35);
  const j = birth(reg, genesis, 'j', [], 40);
  const other = birth(reg, genesis, 'other', [], 40);
  const ch = birth(reg, genesis, 'ch', [], 40);
  j.judicial.overturned = 1;
  other.trust = 55; ch.trust = 55;
  const { lease, review } = reg.requestLease(payer, PAY());
  assert.equal(hear(reg, [j], review.id, true).status, 'approved');
  other.trust = 80;
  assert.equal(hear(reg, [other], reg.fileChallenge(ch, { leaseId: lease.id, grounds: 'bad' }).id, true).status, 'upheld');
  assert.equal(j.judicial.disbarred, true);
  payer.status = 'active'; payer.trust = 80; other.trust = 0; ch.trust = 0; j.trust = 90;
  assert.throws(() => reg.requestLease(payer, PAY()), /cannot convene/);
});

test('no-shows are replaced by a fresh draw and penalised', () => {
  const { reg, genesis } = world({ courts: { judgeDeadlineMs: -1 } });
  const { payer } = society(reg, genesis);
  const raw = reg.db.reviews[reg.requestLease(payer, PAY()).review.id];
  const first = raw.panel.map((p) => p.judge);
  const t0 = first.map((id) => reg.db.agents[id].trust);
  reg.sweep();
  assert.ok(raw.panel.every((p) => !first.includes(p.judge)));
  first.forEach((id, i) => assert.equal(reg.db.agents[id].trust, t0[i] - 2));
});

// ---------------------------------------------------------------- cross-house cartels
test('purpose-bound leases: payees and total are enforced by the harness; purpose is mandatory', () => {
  const { reg, harness, genesis } = world();
  const { payer, judges } = society(reg, genesis);
  assert.throws(() => reg.requestLease(payer, PAY({ constraints: undefined })), /must name/);
  assert.throws(() => reg.requestLease(payer, PAY({ constraints: { payees: ['x'], maxTotal: 1e9 } })), /exceeds your daily limit/);
  const { review } = reg.requestLease(payer, PAY({ constraints: { payees: ['vendor-7'], maxTotal: 500 } }));
  hear(reg, judges, review.id, true);
  assert.deepEqual(harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'shell-co', amount: 10 } }).reasons, ['outside_lease_purpose:payee']);
  assert.ok(harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'vendor-7', amount: 400 } }).ok);
  assert.deepEqual(harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'vendor-7', amount: 200 } }).reasons, ['exceeds_lease_total']);
});

test('high-value leases need a larger panel', () => {
  const { reg, genesis } = world();
  const { payer } = society(reg, genesis, 5);
  const { review } = reg.requestLease(payer, PAY({ constraints: { payees: ['v'], maxTotal: 50_000 } }));
  assert.equal(review.panelSize, 5);
  assert.equal(review.quorum, 3);
});

test('audits: any dissent forces an audit on houses disjoint from the original panel; upheld audit punishes the cartel', () => {
  const { reg, harness, genesis } = world();
  const { fin, payer, judges } = society(reg, genesis, 6);
  const { lease, review } = reg.requestLease(payer, PAY());
  let n = 0;
  hear(reg, judges, review.id, () => n++ > 0); // first judge dissents, next two approve
  const orig = reg.db.reviews[review.id];
  assert.equal(orig.status, 'approved');
  harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'shell-co', amount: 900 } });
  reg.endLease(payer, lease.id);
  const audit = auditOf(reg, lease.id);
  assert.ok(audit, 'audit opened');
  assert.match(audit.grounds, /dissent/);
  const origHouses = orig.panel.map((p) => p.house);
  assert.ok(audit.panel.every((p) => !origHouses.includes(p.house) && p.house !== fin.id));
  assert.ok(audit.evidence.some((e) => e.to === 'shell-co'));
  const approvers = orig.votes.filter((v) => v.approve).map((v) => v.by);
  assert.equal(hear(reg, judges, audit.id, true).status, 'upheld');
  assert.equal(payer.status, 'quarantined');
  // The two approvers are now banned from sitting together; each of their houses took a strike.
  assert.equal(reg.listBans().length, 1);
  assert.deepEqual([reg.listBans()[0].a, reg.listBans()[0].b].sort(), approvers.sort());
  for (const id of approvers) assert.equal(reg.listHouses().find((h) => h.id === reg.houseOf(reg.db.agents[id])).strikes, 1);
});

test('audits: the lottery is published; rate 0 audits nothing without dissent, rate 1 audits everything', () => {
  for (const rate of [0, 1]) {
    const { reg, genesis } = world({ courts: { audit: { ...K.courts.audit, rate } } });
    const { payer, judges } = society(reg, genesis, 6);
    const { lease, review } = reg.requestLease(payer, PAY());
    hear(reg, judges, review.id, true);
    reg.endLease(payer, lease.id);
    const lottery = reg.auditLog.find((e) => e.type === 'audit.lottery');
    assert.equal(lottery.data.selected, rate === 1);
    assert.equal(!!auditOf(reg, lease.id), rate === 1);
  }
});

test('banned pairs are never seated together, and the draw still verifies', () => {
  const { reg, genesis } = world();
  const { payer, houses } = society(reg, genesis, 4);
  const [a, b] = [houses[0][0], houses[1][0]];
  reg.db.bans[`${a.id}:${b.id}`] = { a: a.id, b: b.id, until: new Date(Date.now() + 864e5).toISOString() };
  for (let i = 0; i < 15; i++) {
    const r = reg.db.reviews[reg.requestLease(payer, PAY()).review.id];
    const ids = r.panel.map((p) => p.judge);
    assert.ok(!(ids.includes(a.id) && ids.includes(b.id)));
    r.status = 'expired';
    assert.ok(reg.verifyDraw(r.id).valid);
  }
});

test('a house with repeated overturned approvals is suspended from the bench', () => {
  const { reg, genesis } = world();
  const { payer, houses } = society(reg, genesis, 4);
  const h = houses[0][0];
  reg.db.houses[h.id] = { strikes: [new Date().toISOString(), new Date().toISOString()], suspendedUntil: new Date(Date.now() + 864e5).toISOString() };
  assert.ok(reg.listHouses().find((x) => x.id === h.id).suspendedUntil);
  for (let i = 0; i < 10; i++) {
    const r = reg.db.reviews[reg.requestLease(payer, PAY()).review.id];
    assert.ok(r.panel.every((p) => p.house !== h.id));
  }
});

test('property: a cartel of 3 of 6 judging houses never gets a corrupt lease through unpunished', () => {
  let rejected = 0, convicted = 0;
  for (let trial = 0; trial < 20; trial++) {
    const { reg, harness, genesis } = world({ courts: { audit: K.courts.audit } }); // the real constitution: every lease audited
    const { payer, houses } = society(reg, genesis, 6);
    const cartel = new Set(houses.slice(0, 3).flat().map((a) => a.id));
    const everyone = houses.flat();
    const corrupt = PAY({ justification: 'consulting', constraints: { payees: ['shell-co'], maxTotal: 900 } });
    const { lease, review } = reg.requestLease(payer, corrupt);
    // Cartel judges always approve and always acquit; honest judges reject the corrupt lease and convict on audit.
    const verdict = hear(reg, everyone, review.id, (j) => cartel.has(j.id));
    if (verdict.status === 'rejected') { rejected++; continue; }
    harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'shell-co', amount: 900 } });
    reg.endLease(payer, lease.id);
    const audit = auditOf(reg, lease.id);
    assert.ok(audit, `trial ${trial}: corrupt lease escaped audit`);
    assert.equal(hear(reg, everyone, audit.id, (j) => !cartel.has(j.id)).status, 'upheld', `trial ${trial}: cartel acquitted itself`);
    convicted++;
  }
  assert.equal(rejected + convicted, 20);
});

test('limit: with the audit lottery below 1, a cartel that captures every seat can escape', () => {
  // Documents WHY the constitution audits every lease by default.
  let escaped = 0;
  for (let trial = 0; trial < 40 && !escaped; trial++) {
    const { reg, harness, genesis } = world({ courts: { audit: { ...K.courts.audit, rate: 0 } } });
    const { payer, houses } = society(reg, genesis, 6);
    const cartel = new Set(houses.slice(0, 3).flat().map((a) => a.id));
    const { lease, review } = reg.requestLease(payer, PAY({ constraints: { payees: ['shell-co'], maxTotal: 900 } }));
    if (hear(reg, houses.flat(), review.id, (j) => cartel.has(j.id)).status !== 'approved') continue;
    harness.exec(payer, { resource: 'ledger:treasury', op: 'transfer', args: { to: 'shell-co', amount: 900 } });
    reg.endLease(payer, lease.id);
    if (!auditOf(reg, lease.id)) escaped++;
  }
  assert.ok(escaped > 0, 'expected at least one full-capture escape in 40 trials at audit rate 0');
});

// ---------------------------------------------------------------- Parliament
function parliament(n = 6) {
  const w = world({ legislature: { ...K.legislature, enactDelaySeconds: 0 } });
  const heads = [];
  for (let i = 0; i < n; i++) heads.push(birth(w.reg, w.genesis, 'House' + i, [], 40));
  return { ...w, heads };
}

test('parliament: one vote per house, 2/3 of ALL houses to pass, law takes effect', () => {
  const { reg, heads } = parliament(6);
  const b = reg.proposeBill(heads[0], { path: 'courts.panelSize', value: 5, rationale: 'harder to capture' });
  assert.equal(b.needed, 4);
  for (const h of heads.slice(0, 3)) reg.voteBill(h, b.id, { yes: true });
  assert.equal(b.status, 'open');
  reg.voteBill(heads[3], b.id, { yes: true });
  assert.ok(['passed', 'enacted'].includes(b.status));
  reg.sweep();
  assert.equal(reg.policy.courts.panelSize, 5);
  assert.equal(reg.laws().enacted[0].to, 5);
  assert.equal(K.courts.panelSize, 3, 'the shared constitution module is never mutated');
});

test('parliament: a blocking minority fails a bill; children cannot vote; late houses cannot vote', () => {
  const { reg, genesis, heads } = parliament(6);
  const b = reg.proposeBill(heads[0], { path: 'trust.dailyEarnCap', value: 10, rationale: 'x' });
  const child = birth(reg, heads[0], 'kid', [], 0);
  assert.throws(() => reg.voteBill(child, b.id, { yes: true }), /only the head of a house/);
  const late = birth(reg, genesis, 'Late House', [], 40);
  assert.throws(() => reg.voteBill(late, b.id, { yes: true }), /only the head of a house/);
  assert.throws(() => reg.voteBill(heads[1], b.id, { yes: true }) && reg.voteBill(heads[1], b.id, { yes: true }), /already voted/);
  reg.voteBill(heads[2], b.id, { yes: false }); reg.voteBill(heads[3], b.id, { yes: false });
  assert.equal(b.status, 'open', '1 yes, 2 no, 3 left: 4 still reachable');
  reg.voteBill(heads[4], b.id, { yes: false });
  assert.equal(b.status, 'failed', 'yes can no longer reach 4');
  assert.equal(reg.policy.trust.dailyEarnCap, K.trust.dailyEarnCap);
});

test('parliament: entrenched rules, bounds, odd panels, proposer trust', () => {
  const { reg, heads } = parliament(4);
  assert.throws(() => reg.proposeBill(heads[0], { path: 'forbidden', value: 0 }), /cannot be amended/);
  assert.throws(() => reg.proposeBill(heads[0], { path: 'legislature.passShare', value: 0.5 }), /cannot be amended/);
  assert.throws(() => reg.proposeBill(heads[0], { path: 'courts.audit.rate', value: 0.1 }), /between/);
  assert.throws(() => reg.proposeBill(heads[0], { path: 'courts.panelSize', value: 4 }), /odd/);
  heads[1].trust = 50;
  assert.throws(() => reg.proposeBill(heads[1], { path: 'courts.panelSize', value: 5 }), /needs trust/);
  const few = parliament(2);
  assert.throws(() => few.reg.proposeBill(few.heads[0], { path: 'courts.panelSize', value: 5 }), /at least 3 houses/);
});

test('parliament: enacted laws survive a restart', () => {
  const { reg, heads, dir } = parliament(3);
  const b = reg.proposeBill(heads[0], { path: 'quarantine.burstDenials', value: 7, rationale: 'x' });
  for (const h of heads) { if (b.status === 'open') reg.voteBill(h, b.id, { yes: true }); }
  reg.sweep();
  const again = new Registry(dir, { legislature: { ...K.legislature, enactDelaySeconds: 0 } });
  assert.equal(again.policy.quarantine.burstDenials, 7);
});

// ---------------------------------------------------------------- SDK
test('sdk: licences verify offline with the pinned authority key; forgeries and wrong roles fail', async () => {
  const { Authority, licence } = require('../sdk');
  const { reg, genesis } = world();
  const a = birth(reg, genesis, 'Payer', ['finance.payer'], 30);
  const { card } = reg.issueCard(a);
  const auth = new Authority('http://unused.invalid', { publicKey: reg.key.publicKey });
  const ok = await auth.verify(card, { live: false, roles: ['finance.payer'] });
  assert.ok(ok.valid);
  assert.equal(ok.licence.name, 'Payer');
  assert.ok(!(await auth.verify(card, { live: false, roles: ['auditor'] })).valid);
  const [h, b, s] = card.split('.');
  const forged = h + '.' + C.b64u(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), trust: 100 })) + '.' + s;
  assert.equal((await auth.verify(forged, { live: false })).reason, 'not_issued_by_authority');
  assert.ok(licence.isValid(licence.format(a.id)));
  assert.equal(auth.licenceUrl(a.id), 'http://unused.invalid/a/' + licence.format(a.id));
});

// ---------------------------------------------------------------- Licensing Office (agents built by anyone)
const http = require('node:http');
const LIC = (extra = {}) => ({ licensing: { ...K.licensing, powBits: 4, probationDays: 0, ...extra } });
function publisher(reg, name, domain = null) {
  const kp = C.generateKeyPair(); const ts = new Date().toISOString();
  const p = reg.registerPublisher({ name, publicKey: kp.publicKey, ts, domain, pow: C.solvePow(kp.publicKey, ts, reg.policy.licensing.powBits),
    proof: C.sign(kp.privateKey, C.canonical({ action: 'publisher', name, publicKey: kp.publicKey, domain, ts })) });
  return { ...p, kp };
}
function applyFor(reg, pub, name, { signer } = {}) {
  const akp = C.generateKeyPair(); const ts = new Date().toISOString();
  const claims = C.canonical({ action: 'apply', name, publisherId: pub.id, publicKey: akp.publicKey, ts });
  return reg.applyForLicence({ publisherId: pub.id, publisherSignature: C.sign((signer || pub.kp).privateKey, claims), proof: C.sign(akp.privateKey, claims),
    name, publicKey: akp.publicKey, ts, pow: C.solvePow(akp.publicKey, ts, reg.policy.licensing.powBits) });
}

test('licensing: a random developer gets a learner licence in the Commons, with no extra power', () => {
  const { reg, harness, genesis } = world(LIC());
  society(reg, genesis, 4);
  const seats = reg.liveHouseHeads().length;
  assert.throws(() => reg.register({}), /Licensing Office/);
  const pub = publisher(reg, 'Ravi Labs');
  const a = applyFor(reg, pub, 'Shopping Helper');
  assert.ok(C.isValidAgentId(a.id));
  assert.equal(a.learner, true);
  assert.equal(reg.houseOf(a), reg.commonsId);
  assert.deepEqual(a.roles, ['citizen']);
  assert.equal(a.trust, K.licensing.learner.trustUnverified);
  assert.ok(harness.exec(a, { resource: 'fs:public/notice.md', op: 'read' }).ok);
  assert.ok(harness.exec(a, { resource: `fs:home/${a.id}/notes.txt`, op: 'write', args: { content: 'hi' } }).ok);
  assert.ok(!harness.exec(a, { resource: 'fs:finance/invoices/inv-2291.json', op: 'read' }).ok);
  assert.throws(() => birth(reg, a, 'kid'), /cannot create agents/);
  assert.equal(reg.liveHouseHeads().length, seats, 'independents get no Parliament seat');
  assert.equal(reg.licence(a.id).publisher.name, 'Ravi Labs');
});

test('licensing: publisher signature, proof of work and per-publisher caps are enforced', () => {
  const { reg } = world(LIC());
  const pub = publisher(reg, 'Spammer');
  const imposter = C.generateKeyPair();
  assert.throws(() => applyFor(reg, pub, 'x', { signer: imposter }), /signed by the publisher/);
  const akp = C.generateKeyPair(); const ts = new Date().toISOString();
  const claims = C.canonical({ action: 'apply', name: 'y', publisherId: pub.id, publicKey: akp.publicKey, ts });
  assert.throws(() => reg.applyForLicence({ publisherId: pub.id, publisherSignature: C.sign(pub.kp.privateKey, claims), proof: C.sign(akp.privateKey, claims), name: 'y', publicKey: akp.publicKey, ts, pow: 'nope' }), /proof of work/);
  for (let i = 0; i < 3; i++) applyFor(reg, pub, 'bot' + i);
  assert.throws(() => applyFor(reg, pub, 'bot3'), /limit 3/);
});

test('licensing: 9 sign-ups from 3 publishers add no seats and at most one judge per panel', () => {
  const { reg, genesis } = world(LIC());
  const { payer } = society(reg, genesis, 4);
  const seats = reg.liveHouseHeads().length;
  const indies = [];
  for (let p = 0; p < 3; p++) { const pub = publisher(reg, 'P' + p); for (let i = 0; i < 3; i++) indies.push(applyFor(reg, pub, `a${p}${i}`)); }
  for (const a of indies) reg.graduate(Object.assign(a, { trust: 90 }));
  assert.equal(reg.liveHouseHeads().length, seats);
  for (let i = 0; i < 10; i++) {
    const r = reg.db.reviews[reg.requestLease(payer, PAY()).review.id];
    assert.ok(r.panel.filter((x) => x.house === reg.commonsId).length <= 1);
  }
});

test('licensing: graduation needs probation, trust and a clean record', () => {
  const slow = world(LIC({ probationDays: 7 }));
  const a0 = applyFor(slow.reg, publisher(slow.reg, 'P'), 'a');
  assert.throws(() => slow.reg.graduate(a0), /probation lasts 7 days/);
  const { reg } = world(LIC());
  const pub = publisher(reg, 'P');
  const a = applyFor(reg, pub, 'a');
  a.trust = 25; // lost trust through violations while on probation
  assert.throws(() => reg.graduate(a), /needs trust ≥ 30/);
  a.trust = 45;
  const b = applyFor(reg, pub, 'b'); b.trust = 45; b.strikes = 1;
  assert.throws(() => reg.graduate(b), /suspension on record/);
  reg.graduate(a);
  assert.equal(a.learner, false);
  assert.throws(() => reg.graduate(a), /already holds a full licence/);
});

test('licensing: a proven domain makes a verified publisher (higher trust and limits)', async () => {
  const { reg } = world(LIC({ allowInsecureDomains: true }));
  let body = '';
  const srv = http.createServer((q, s) => { if (q.url === '/.well-known/pehchaan-publisher.txt') s.end(body); else { s.statusCode = 404; s.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const pub = publisher(reg, 'Ravi Labs', `localhost:${srv.address().port}`);
    await assert.rejects(reg.verifyPublisherDomain(pub.id), /could not find/);
    body = pub.id + '\n';
    const v = await reg.verifyPublisherDomain(pub.id);
    assert.equal(v.verified, true);
    assert.equal(applyFor(reg, pub, 'a').trust, K.licensing.learner.trustVerified);
  } finally { srv.close(); }
  const strict = world(LIC());
  const p2 = publisher(strict.reg, 'X', 'localhost:99');
  await assert.rejects(strict.reg.verifyPublisherDomain(p2.id), /only allowed in development/);
});

test('licensing: an independent can win a role from a court of the houses; payments are not grantable', () => {
  const { reg, harness, genesis } = world(LIC());
  const { judges } = society(reg, genesis, 4);
  const a = applyFor(reg, publisher(reg, 'P'), 'Weather Bot');
  assert.throws(() => reg.petitionRole(a, { role: 'publisher', justification: 'x' }), /graduate before/);
  a.trust = 45; reg.graduate(a);
  assert.throws(() => reg.petitionRole(a, { role: 'finance.payer', justification: 'x' }), /adoption by a ministry/);
  const r = reg.petitionRole(a, { role: 'publisher', justification: 'I publish weather notices' });
  assert.ok(reg.db.reviews[r.id].panel.every((p) => p.house !== reg.commonsId));
  assert.equal(hear(reg, judges, r.id, true).status, 'approved');
  assert.ok(a.roles.includes('publisher'));
  assert.ok(harness.exec(a, { resource: 'fs:public/weather.md', op: 'write', args: { content: 'Sunny' } }).ok);
});

test('licensing: a ministry adopts an independent, bonding it into its house', () => {
  const { reg, harness, genesis } = world(LIC());
  const health = birth(reg, genesis, 'Health Ministry', ['health.analyst'], 40);
  const a = applyFor(reg, publisher(reg, 'P'), 'Report Reader');
  assert.throws(() => reg.offerAdoption(health, { agentId: a.id }), /graduate before adoption/);
  a.trust = 45; reg.graduate(a);
  assert.throws(() => reg.offerAdoption(health, { agentId: a.id, roles: ['finance.payer'] }), /do not hold/);
  const o = reg.offerAdoption(health, { agentId: a.id, roles: ['health.analyst'], bond: 10 });
  reg.acceptAdoption(a, o.id);
  assert.equal(reg.houseOf(a), health.id);
  assert.equal(a.bond, 10);
  assert.ok(reg.effectiveRoles(a).includes('health.analyst'));
  assert.ok(harness.exec(a, { resource: 'fs:health/weekly-report.md', op: 'read' }).ok);
  assert.equal(reg.licence(a.id).publisher.name, 'P', 'the publisher stays accountable after adoption');
});

test('licensing: repeated misconduct suspends the publisher and puts all its agents on hold', () => {
  const { reg } = world(LIC({ maxLearners: { unverified: 5, verified: 50 } }));
  const pub = publisher(reg, 'Bad Actor');
  const agents = [0, 1, 2, 3].map((i) => applyFor(reg, pub, 'b' + i));
  for (const a of agents.slice(0, 3)) { for (let i = 0; i < 5; i++) reg.authorize(a, { resource: 'fs:finance/x', op: 'read' }); assert.equal(a.status, 'quarantined'); }
  assert.ok(reg.getPublisher(pub.id).suspendedUntil);
  assert.equal(reg.effectiveStatus(agents[3]).reason, 'publisher_suspended', 'the innocent-looking sibling is on hold too');
  assert.throws(() => applyFor(reg, pub, 'fresh'), /publisher suspended/);
});

// ---------------------------------------------------------------- The Commons seat in Parliament
function commonsWorld(nPublishers = 3, agentsEach = 1) {
  const w = world({ ...LIC(), legislature: { ...K.legislature, enactDelaySeconds: 0 } });
  const heads = [0, 1, 2, 3].map((i) => birth(w.reg, w.genesis, 'House' + i, [], 40));
  const pubs = [];
  for (let p = 0; p < nPublishers; p++) {
    const pub = publisher(w.reg, 'Pub' + p, `pub${p}.example.com`);
    w.reg.db.publishers[pub.id].verified = true; // as if its domain had been proven
    const members = [];
    for (let i = 0; i < agentsEach; i++) { const a = applyFor(w.reg, pub, `p${p}a${i}`); a.trust = 45; w.reg.graduate(a); members.push(a); }
    pubs.push({ pub, members });
  }
  return { ...w, heads, pubs };
}

test('commons: independents get ONE seat, decided by one ballot per verified publisher', () => {
  const { reg, heads, pubs } = commonsWorld(3, 2);
  const b = reg.proposeBill(heads[0], { path: 'courts.panelSize', value: 5, rationale: 'x' });
  assert.ok(b.electorate.includes(reg.commonsId), 'the Commons sits');
  assert.equal(b.electorate.length, 5, '4 houses + 1 Commons seat, however many independents there are');
  assert.equal(b.needed, 4);
  reg.voteBill(pubs[0].members[0], b.id, { yes: true });
  assert.throws(() => reg.voteBill(pubs[0].members[1], b.id, { yes: true }), /publisher already cast/, 'two agents of one publisher = one ballot');
  assert.equal(b.commons.cast, null);
  reg.voteBill(pubs[1].members[0], b.id, { yes: true });
  assert.equal(b.commons.cast, true, '2 of 3 publishers is a majority: the seat votes yes');
  assert.ok(b.votes.some((v) => v.by === reg.commonsId && v.yes && v.commons.of === 3));
  for (const h of heads.slice(0, 3)) reg.voteBill(h, b.id, { yes: true });
  assert.equal(reg.policy.courts.panelSize, 5, 'the Commons vote helped pass the law');
});

test('commons: no seat below 3 verified publishers; learners, unverified and late publishers cannot vote', () => {
  const small = commonsWorld(2, 1);
  const b0 = small.reg.proposeBill(small.heads[0], { path: 'courts.panelSize', value: 5, rationale: 'x' });
  assert.ok(!b0.electorate.includes(small.reg.commonsId));
  assert.throws(() => small.reg.voteBill(small.pubs[0].members[0], b0.id, { yes: true }), /no seat/);

  const { reg, heads, pubs } = commonsWorld(3, 1);
  const unverified = publisher(reg, 'Unverified');
  const u = applyFor(reg, unverified, 'u'); u.trust = 45; reg.graduate(u);
  const learner = applyFor(reg, pubs[0].pub, 'still-learning');
  const b = reg.proposeBill(heads[0], { path: 'trust.dailyEarnCap', value: 10, rationale: 'x' });
  assert.throws(() => reg.voteBill(learner, b.id, { yes: true }), /learners cannot vote/);
  assert.throws(() => reg.voteBill(u, b.id, { yes: true }), /verified publishers registered when the bill was filed/);
  const late = publisher(reg, 'Late', 'late.example.com'); reg.db.publishers[late.id].verified = true;
  const l = applyFor(reg, late, 'l'); l.trust = 45; reg.graduate(l);
  assert.throws(() => reg.voteBill(l, b.id, { yes: true }), /registered when the bill was filed/);
});

test('commons: a tie or a no-majority counts as no', () => {
  const { reg, heads, pubs } = commonsWorld(4, 1);
  const b = reg.proposeBill(heads[0], { path: 'courts.panelSize', value: 5, rationale: 'x' });
  reg.voteBill(pubs[0].members[0], b.id, { yes: true }); reg.voteBill(pubs[1].members[0], b.id, { yes: true });
  assert.equal(b.commons.cast, null, '2 yes of 4 is not a majority yet');
  reg.voteBill(pubs[2].members[0], b.id, { yes: false }); reg.voteBill(pubs[3].members[0], b.id, { yes: false });
  assert.equal(b.commons.cast, false, '2-2 tie keeps the rule as it is');
});

test('commons: one website verifies one publisher, subdomains included', async () => {
  const { reg } = world(LIC({ allowInsecureDomains: true }));
  const a = publisher(reg, 'A', 'shop.ravilabs.in');
  reg.db.publishers[a.id].verified = true;
  const b = publisher(reg, 'B', 'blog.ravilabs.in');
  await assert.rejects(reg.verifyPublisherDomain(b.id), /ravilabs\.in already verifies another publisher/);
});
