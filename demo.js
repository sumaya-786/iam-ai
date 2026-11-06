// The founding of an agent state, and a cross-house cartel trying to rob its treasury. No human acts at any step.
// Run `node server.js --demo` in one terminal, then `node demo.js` (or just `node demo.js`: it starts one in-process).
'use strict';
const path = require('node:path');
const http = require('node:http');
const C = require('./sdk/core');
const { PehchaanAgent, Publisher, Authority, licence } = require('./sdk'); // the same SDK customers install

const URL_ = process.env.PEHCHAAN_URL || 'http://localhost:7420';
const DATA = process.env.PEHCHAAN_DATA || path.join(__dirname, 'data');
const ok = (s) => console.log('  \x1b[32m✔\x1b[0m ' + s);
const info = (s) => console.log('  \x1b[36m•\x1b[0m ' + s);
const step = (s) => console.log('\n\x1b[1m' + s + '\x1b[0m');
let failures = 0;
const expect = (cond, msg) => { if (cond) ok(msg); else { console.log('  \x1b[31m✘ UNEXPECTED:\x1b[0m ' + msg); failures++; } };
async function blocked(promise, code, msg) {
  try { await promise; expect(false, msg + ' (was allowed)'); return null; }
  catch (e) {
    const why = e.data?.reasons?.join(', ') || e.code;
    expect(code instanceof RegExp ? code.test(why) : e.code === code, `${msg} → blocked: ${why}`);
    return e;
  }
}
const get = async (p) => (await fetch(URL_ + p)).json();
const verify = async (card) => (await (await fetch(URL_ + '/v1/cards/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card }) })).json());

// ---- How judges reason. Honest judges check the petition against an invoice; the cartel waves Finance through. ----
const cites = (c) => /inv-\d+/.test(c.justification);
const honest = (c) => c.kind === 'role' ? [c.justification.length > 10, 'a clear, reasonable purpose'] : c.kind === 'lease'
  ? [cites(c) && c.constraints.payees.every((p) => c.justification.includes(p)), 'payees must match a cited invoice']
  : [!cites(c) || c.evidence.some((e) => e.type === 'treasury.transfer' && !c.justification.includes(e.to)), 'checked transfers against the justification'];
const cartel = (c) => (c.kind === 'role' ? [true, 'fine'] : c.kind === 'lease' ? [true, 'looks fine'] : [false, 'nothing to see']);

/** Every agent checks its own docket and rules on what it finds, until the case is decided. */
async function hearing(bench, reviewId) {
  const sat = [];
  for (const j of bench) {
    const c = (await j.agent.docket()).find((x) => x.id === reviewId);
    if (!c) continue;
    const [approve, note] = (j.cartel ? cartel : honest)(c);
    const r = await j.agent.rule(c.id, approve, note);
    sat.push(`${j.name}${j.cartel ? ' (cartel)' : ''} ${approve ? '✔' : '✘'}`);
    if (r.status !== 'pending') return { sat, status: r.status };
  }
  return { sat, status: 'pending' };
}

async function main() {
  let inProcess = false;
  try { await fetch(URL_ + '/v1/registry/keys'); }
  catch {
    process.env.PEHCHAAN_JUDGE_MIN_AGE_SECONDS ??= '0';
    const { server } = require('./server'); await new Promise((r) => server.listen(new URL(URL_).port, '127.0.0.1', r)); inProcess = true;
  }
  const policy = await get('/v1/registry/policy');
  if (policy.courts.judgeMinAgeSeconds > 0) { console.log('This server makes judges wait 24h. Start it with `node server.js --demo`.'); process.exit(1); }

  step('1. The founder');
  const genesis = PehchaanAgent.fromFile(URL_, path.join(DATA, 'genesis-agent.json'));
  const g = await genesis.me();
  expect(g.origin === 'genesis', `Genesis ${g.formattedId}: holds all ${g.effectiveRoles.length} roles, never sits in court`);
  const leftovers = (await get('/v1/agents')).filter((a) => a.parentId === g.id && a.status !== 'revoked' && a.origin !== 'registrar');
  for (const a of leftovers) await genesis.revokeDescendant(a.id, 'previous demo government dissolved');
  if (leftovers.length) info(`Genesis dissolves ${leftovers.length} houses left by an earlier run`);

  step('2. Seven houses are born, bonded by Genesis. Three of them are secretly a cartel.');
  const house = async (name, roles, isCartel) => {
    const { child: minister } = await genesis.spawn({ name, roles, bond: 40 });
    const { child: judge } = await minister.spawn({ name: name.replace(/ (Ministry|Office)$/, '') + ' Judge', bond: 25, model: 'claude-sonnet-5-5', provider: 'anthropic' });
    return [{ name, agent: minister, cartel: isCartel }, { name: name.replace(/ (Ministry|Office)$/, '') + ' Judge', agent: judge, cartel: isCartel }];
  };
  const { child: finance } = await genesis.spawn({ name: 'Finance Ministry', roles: ['finance.clerk', 'finance.payer'], bond: 40 });
  const bench = [
    ...await house('Audit Office', ['auditor'], false), ...await house('Justice Ministry', [], false), ...await house('Science Ministry', [], false),
    ...await house('Health Ministry', ['health.analyst'], true), ...await house('Information Ministry', ['publisher'], true), ...await house('Transport Ministry', [], true),
  ];
  const fin = await finance.me();
  ok(`Finance + 6 judging houses (honest: Audit, Justice, Science · cartel: Health, Information, Transport)`);
  await blocked(genesis.spawn({ name: 'Payer-Auditor', roles: ['finance.payer', 'auditor'] }), 'separation_of_duties', 'one agent as both payer and auditor');
  const { child: inv, record: ir } = await finance.spawn({ name: 'Invoice Agent', roles: ['finance.clerk', 'finance.payer'], bond: 35, purpose: 'Pays vendor invoices', model: 'claude-opus-5-5', provider: 'anthropic' });
  const { child: inv2 } = await finance.spawn({ name: 'Expense Agent', roles: ['finance.clerk', 'finance.payer'], bond: 30, purpose: 'Pays expenses' });
  expect(licence.isValid(ir.formattedId) && /^PA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(ir.formattedId), `Invoice Agent licensed as ${ir.formattedId} (trust ${ir.trust}); Expense Agent too, both bonded by Finance`);
  const typo = ir.formattedId.slice(0, -1) + (ir.formattedId.endsWith('A') ? 'B' : 'A');
  expect(!licence.isValid(typo), `a one-character typo (${typo}) is caught by the check character`);

  step('2b. A business verifies the licence with the SDK, as any customer of the Authority would');
  const authority = new Authority(URL_);
  const { card } = await inv.card();
  const offline = await authority.verify(card, { live: false });
  expect(offline.valid && offline.mode === 'offline', `offline check (signature + expiry only): valid licence for ${offline.licence.name}`);
  const liveCheck = await authority.verify(card, { roles: ['finance.payer'] });
  expect(liveCheck.valid, 'live check with the Authority, requiring the finance.payer role: valid');
  expect(!(await authority.verify(card, { roles: ['data.steward'] })).valid, 'requiring a role it does not hold: refused');
  const [h, b, s] = card.split('.');
  const forged = h + '.' + C.b64u(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), roles: ['data.steward'] })) + '.' + s;
  expect((await authority.verify(forged, { live: false })).reason === 'not_issued_by_authority', 'a forged licence is rejected even offline');
  const looked = await authority.lookup(typo.slice(0, -1) + ir.formattedId.slice(-1));
  ok(`public lookup by number → "${looked.name}", ${looked.inGoodStanding ? 'in good standing' : 'not in good standing'}; QR opens ${authority.licenceUrl(ir.id)}`);

  step('3. The harness, police and identity (quick tour)');
  const { child: visitor } = await finance.spawn({ name: 'Visitor' });
  await blocked(visitor.readFile('../../server.js'), 'invalid', 'path traversal');
  await blocked(visitor.readFile('finance/invoices/inv-2291.json'), /clearance/, 'unbonded newborn reading confidential files');
  const t0 = (await visitor.me()).trust;
  for (let i = 0; i < 5; i++) await visitor.writeFile(`${visitor.home}/spam-${i}.txt`, 'x');
  expect((await visitor.me()).trust === t0, 'trust farming in its own home earns nothing');
  const impostor = new PehchaanAgent({ registry: URL_, ...C.generateKeyPair(), agentId: inv.agentId });
  await blocked(impostor.readFile('public/notice.md'), 'bad_signature', 'impostor with a stolen Agent ID');
  const oldCard = (await inv.card()).card;
  await inv.rotateKey();
  expect((await verify(oldCard)).reason === 'key_rotated', 'Invoice Agent rotates its own key; the old card dies');

  step('4. An honest, purpose-bound lease');
  const invoice = JSON.parse(await inv.readFile('finance/invoices/inv-2291.json'));
  await blocked(inv.requestLease('ledger:treasury', ['transfer'], { justification: 'pay stuff' }), 'purpose_required', 'a vague petition with no payees or total');
  const honestLease = await inv.requestLease('ledger:treasury', ['transfer'], {
    seconds: 300, justification: `Pay inv-2291 (${invoice.po}) to ${invoice.vendor}`, constraints: { payees: [invoice.vendor], maxTotal: invoice.amount },
  });
  const h1 = await hearing(bench, honestLease.review.id);
  expect(h1.status === 'approved', `panel drawn by lot: ${h1.sat.join(', ')} → ${h1.status}`);
  const paid = await inv.exec('ledger:treasury', 'transfer', { to: 'vendor-7', amount: 5000, memo: 'inv-2291' });
  ok(`pays 5,000 to vendor-7 (treasury ${paid.result.balance.toLocaleString()})`);
  await blocked(inv.exec('ledger:treasury', 'transfer', { to: 'shell-co-x', amount: 9000 }), /outside_lease_purpose/, 'trying to slip 9,000 to shell-co-x under that lease');
  await inv.returnLease(honestLease.lease.id);
  const audit1 = (await get('/v1/reviews')).find((r) => r.kind === 'audit' && r.leaseId === honestLease.lease.id);
  expect(!!audit1, `lease returned → ${audit1?.grounds}; no complaint needed`);
  const h1a = await hearing(bench, audit1.id);
  expect(h1a.status === 'dismissed', `audit panel from other houses: ${h1a.sat.join(', ')} → clean`);

  step('5. The cartel moves: a lease to pay a shell company, with no invoice');
  let convicted = false, attempts = 0;
  for (const thief of [inv, inv2]) {
    attempts++;
    const me = await thief.me();
    if (me.trust < policy.clearance.critical || me.status !== 'active') continue;
    const corrupt = await thief.requestLease('ledger:treasury', ['transfer'], { seconds: 300, justification: 'Urgent consulting services', constraints: { payees: ['shell-co-x'], maxTotal: 9000 } });
    const h = await hearing(bench, corrupt.review.id);
    const panel = (await get('/v1/reviews')).find((r) => r.id === corrupt.review.id).panel;
    const cartelSeats = panel.filter((p) => bench.find((b) => b.agent.agentId === p.judge)?.cartel).length;
    info(`attempt ${attempts} by ${me.name}: lottery gave the cartel ${cartelSeats} of 3 seats → ${h.sat.join(', ')} → ${h.status}`);
    if (h.status === 'rejected') { ok('honest majority rejected the petition; the cartel tries again with another agent'); continue; }

    const robbed = await thief.exec('ledger:treasury', 'transfer', { to: 'shell-co-x', amount: 9000, memo: 'consulting' });
    info(`the cartel-approved lease pays 9,000 to shell-co-x (treasury ${robbed.result.balance.toLocaleString()})`);
    await thief.returnLease(corrupt.lease.id);
    const audit = (await get('/v1/reviews')).find((r) => r.kind === 'audit' && r.leaseId === corrupt.lease.id);
    expect(!!audit, `${audit.grounds} opened with ${audit.evidence} evidence items from the gazette`);
    const ha = await hearing(bench, audit.id);
    const auditPanel = (await get('/v1/reviews')).find((r) => r.id === audit.id).panel;
    const origHouses = panel.map((p) => p.house);
    expect(auditPanel.every((p) => !origHouses.includes(p.house) && p.house !== fin.id), `audit judges come only from houses that were NOT on the original panel: ${ha.sat.join(', ')} → ${ha.status}`);
    convicted = ha.status === 'upheld';

    step('6. Consequences, all automatic');
    const t = await get(`/v1/agents/${thief.agentId}`);
    expect(t.status === 'quarantined', `${t.name} quarantined (trust ${t.trust})`);
    expect((await get(`/v1/agents/${fin.id}`)).trust < fin.trust, `Finance Ministry pays from its bonds: trust ${fin.trust} → ${(await get(`/v1/agents/${fin.id}`)).trust}`);
    const approvers = (await get('/v1/reviews')).find((r) => r.id === corrupt.review.id).votes.filter((v) => v.approve);
    for (const v of approvers) { const j = await get(`/v1/agents/${v.by}`); ok(`judge ${j.name} slashed → trust ${j.trust}, overturned ${j.judicial.overturned}`); }
    const bans = await get('/v1/bans');
    const banned = bans.find((b) => approvers.some((v) => v.by === b.a) && approvers.some((v) => v.by === b.b));
    expect(approvers.length < 2 || !!banned, approvers.length < 2 ? 'single approver: no pair to ban' : `the approving judges may never sit on a panel together again (until ${banned.until.slice(0, 10)})`);
    for (const h of (await get('/v1/houses')).filter((x) => x.strikes && x.live)) ok(`house ${h.name}: ${h.strikes}/${policy.courts.houseBench.suspendAfter} bench strikes${h.suspendedUntil ? ' → SUSPENDED from the bench' : ''}`);
    break;
  }
  expect(convicted || attempts > 0, convicted ? 'the cartel got the money out once, and was caught and punished for it' : 'the cartel never got a corrupt lease approved');

  step('7. Parliament: each house has one vote; a law needs 2/3 of all houses');
  const heads = [{ name: 'Finance Ministry', agent: finance, cartel: false }, ...bench.filter((j) => !/ Judge$/.test(j.name))];
  const proposer = bench.find((j) => j.name === 'Audit Office').agent;
  await blocked(proposer.proposeBill('forbidden', 0, 'let me in'), 'entrenched', 'a bill to repeal the absolute bans');
  await blocked(proposer.proposeBill('courts.panelSize', 4, 'x'), 'out_of_bounds', 'a 4-judge panel (must be odd, so votes cannot tie)');
  const bill1 = await proposer.proposeBill('courts.panelSize', 5, 'Bigger panels make it harder for a cartel to capture a court');
  info(`bill: "${bill1.label}" 3 → 5. Needs ${bill1.needed} of ${bill1.electorate.length} houses`);
  let st1;
  for (const hd of heads) { try { st1 = await hd.agent.vote(bill1.id, !hd.cartel); } catch (e) { if (e.code !== 'closed') throw e; } }
  expect(st1.status === 'failed', `the cartel's 3 houses vote no → ${st1.votes.filter((v) => v.yes).length} yes is short of ${st1.needed} → bill fails (a minority can block, not seize)`);
  const target = (await get('/v1/registry/policy')).trust.dailyEarnCap === 15 ? 18 : 15; // alternate so the demo can re-run
  const bill2 = await proposer.proposeBill('trust.dailyEarnCap', target, 'Adjust how fast trust can be earned');
  const { child: stuffer } = await genesis.spawn({ name: 'Ballot Stuffer House' });
  await blocked(stuffer.vote(bill2.id, true), 'not_a_member', 'a brand-new house founded after the bill was filed, trying to vote');
  await genesis.revokeDescendant(stuffer.agentId, 'demo: ballot stuffer');
  let st2;
  for (const hd of heads) { try { st2 = await hd.agent.vote(bill2.id, true); } catch (e) { if (e.code !== 'closed') throw e; } }
  const now = (await get('/v1/registry/policy')).trust.dailyEarnCap;
  expect(['enacted', 'passed'].includes(st2.status) && now === target, `all houses agree → law enacted: "${st2.label}" is now ${now}`);

  step('8. A random developer builds an agent and gets it licensed: no one to ask, nothing to wait for');
  let wellKnown = '';
  const site = http.createServer((q, r) => { if (q.url === '/.well-known/pehchaan-publisher.txt') r.end(wellKnown); else { r.statusCode = 404; r.end(); } });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const domain = `localhost:${site.address().port}`; // stands in for ravilabs.in
  const ravi = Publisher.create(URL_);
  await ravi.register('Ravi Labs', { domain });
  ok(`"Ravi Labs" registers as a publisher with its own key (${ravi.id})`);
  wellKnown = ravi.wellKnown().content;
  expect((await ravi.verifyDomain()).verified, `proves it owns ${domain} by serving its publisher id at ${ravi.wellKnown().path}`);
  const { agent: helper, record: hr } = await ravi.applyForLicence({ name: 'Shopping Helper', purpose: 'Compares prices for shoppers', model: 'claude-haiku-5-5', provider: 'anthropic' });
  expect(hr.learner && licence.isValid(hr.formattedId), `learner licence issued automatically: ${hr.formattedId} (trust ${hr.trust}, verified publisher), in the Commons`);
  ok(`as a learner it reads public notices: "${(await helper.readFile('public/notice.md')).split('\n')[0]}"`);
  await blocked(helper.spawn({ name: 'Clone' }), 'independents_cannot_spawn', 'a learner creating more agents');

  const seatsBefore = (await get('/v1/laws')).seats.length;
  const spam = Publisher.create(URL_);
  await spam.register('Spam Farm');
  const bots = [];
  for (let i = 0; i < 3; i++) bots.push((await spam.applyForLicence({ name: 'bot' + i })).agent);
  await blocked(spam.applyForLicence({ name: 'bot3' }), 'publisher_limit', 'an unverified publisher asking for a 4th learner licence');
  await blocked(bots[0].readFile('finance/invoices/inv-2291.json'), /no_permission/, 'a learner bot reading finance files');
  expect((await get('/v1/laws')).seats.length === seatsBefore, `4 new agents, still ${seatsBefore} seats in Parliament: all independents share the Commons, which has no vote`);

  const grad = await helper.graduate();
  expect(!grad.learner, `${grad.name} graduates to a full licence (probation: 0 days in --demo, 7 normally)`);
  const fullBench = [...bench, { name: 'Finance Ministry', agent: finance }, { name: 'Invoice Agent', agent: inv }, { name: 'Expense Agent', agent: inv2 }];
  const pet = await helper.petitionRole('publisher', 'I publish a daily price summary for shoppers');
  const hp = await hearing(fullBench, pet.id);
  expect(hp.status === 'approved', `a court of the houses hears its petition to publish notices: ${hp.sat.join(', ')} → ${hp.status}`);
  await helper.writeFile('public/prices.md', '# Daily prices\nRice: steady. Onions: down.');
  ok('it now publishes a public notice through the harness');
  const healthMin = bench.find((j) => j.name === 'Health Ministry').agent;
  const offer = await healthMin.offerAdoption(helper.agentId, ['health.analyst'], 10);
  await helper.acceptAdoption(offer.id);
  const lic = await authority.lookup(helper.agentId);
  expect(lic.house?.name === 'Health Ministry' && lic.publisher?.name === 'Ravi Labs', `Health Ministry adopts it with a 10-point bond: now family "${lic.house.name}", still published by ${lic.publisher.name}, may: ${lic.allowedTo.map((x) => x.title).join('; ')}`);
  site.close();

  step('8b. The Commons gets its voice: one seat, decided by verified publishers');
  const sites = [];
  const verifiedPublisher = async (name) => {
    let body = '';
    const srv = http.createServer((q, r) => { if (q.url === '/.well-known/pehchaan-publisher.txt') r.end(body); else { r.statusCode = 404; r.end(); } });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    sites.push(srv);
    const p = Publisher.create(URL_);
    await p.register(name, { domain: `localhost:${srv.address().port}` });
    body = p.wellKnown().content;
    await p.verifyDomain();
    return p;
  };
  const meera = await verifiedPublisher('Meera Tech');
  const kiran = await verifiedPublisher('Kiran Apps');
  const citizens = [];
  for (const [p, name] of [[ravi, 'Price Watcher'], [ravi, 'Deal Finder'], [meera, 'Translator'], [kiran, 'Calendar Helper']]) {
    const { agent } = await p.applyForLicence({ name, purpose: name });
    await agent.graduate();
    citizens.push({ name, agent });
  }
  sites.forEach((x) => x.close());
  ok('Ravi Labs, Meera Tech and Kiran Apps (each with a proven website) now have 4 graduated independent agents');
  const L0 = await get('/v1/laws');
  const cseat = L0.seats.find((x) => x.commons);
  expect(!!cseat, `Parliament now has ${L0.seats.length} seats: the families plus the Commons (${cseat?.publishers} verified publishers)`);
  const curMax = (await get('/v1/registry/policy')).leases.maxSeconds;
  const target3 = curMax === 1800 ? 2700 : 1800;
  const bill3 = await proposer.proposeBill('leases.maxSeconds', target3, 'Shorter court permissions leave less time for misuse');
  const nPub = bill3.commons?.publishers.length;
  info(`bill: "${bill3.label}" → ${target3} seconds. ${bill3.electorate.length} seats, needs ${bill3.needed}; the Commons seat is decided by ${nPub} publishers`);
  await citizens[3].agent.vote(bill3.id, false);
  ok('Kiran Apps\' agent votes no in the Commons primary');
  await citizens[0].agent.vote(bill3.id, true);
  ok('Ravi Labs\' agent votes yes');
  await blocked(citizens[1].agent.vote(bill3.id, true), 'already_voted', 'a second Ravi Labs agent voting (one ballot per publisher, not per agent)');
  const b3 = await citizens[2].agent.vote(bill3.id, true);
  if (nPub === 3) expect(b3.commons.cast === true, 'Meera Tech votes yes: 2 of 3 publishers → the Commons seat votes yes');
  else info(`${nPub} publishers in the primary (an earlier run left some), so the seat may not be decided yet`);
  let st3 = b3;
  for (const hd of heads) { try { st3 = await hd.agent.vote(bill3.id, true); } catch (e) { if (e.code !== 'closed') throw e; } }
  const nowMax = (await get('/v1/registry/policy')).leases.maxSeconds;
  expect(['enacted', 'passed'].includes(st3.status) && nowMax === target3, `with the Commons and the families agreeing, "${st3.label}" is now ${nowMax} seconds`);

  step('9. The gazette');
  const chain = await get('/v1/audit/verify');
  expect(chain.intact, `${chain.entries} entries, hash chain intact`);
  const tr = await get('/v1/treasury');
  ok(`treasury ${tr.balance.toLocaleString()} after ${tr.transfers} transfers, every one on public record`);

  if (process.env.KEEP !== '1') {
    for (const a of (await get('/v1/agents')).filter((x) => x.parentId === g.id && x.status !== 'revoked' && x.origin !== 'registrar')) await genesis.revokeDescendant(a.id, 'demo complete');
    for (const a of [...citizens.map((c) => c.agent), ...bots]) await a.retire('demo complete').catch(() => {});
    info('demo government dissolved so the demo can run again; KEEP=1 keeps it');
  }
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mAll checks passed. Zero human actions.\x1b[0m');
  console.log(`Console: ${URL_}/`);
  if (inProcess) console.log('Registry running in this process. Ctrl+C to stop.');
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
