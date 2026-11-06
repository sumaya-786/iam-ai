// Pehchaan: IAM + harness for a self-governing agent state. Zero dependencies: `node server.js`
'use strict';
// --demo: judges may sit immediately (the real constitution makes them wait 24h, against sock puppets).
if (process.argv.includes('--demo')) {
  process.env.PEHCHAAN_JUDGE_MIN_AGE_SECONDS ??= '0';
  process.env.PEHCHAAN_ENACT_DELAY_SECONDS ??= '0'; // laws take effect as soon as they pass (real default: 1h cooling-off)
  process.env.PEHCHAAN_PROBATION_DAYS ??= '0';      // learners may graduate at once (real default: 7 days)
  process.env.PEHCHAAN_ALLOW_INSECURE_DOMAINS ??= 'on'; // publishers may prove http://localhost domains
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Registry, GovError } = require('./lib/registry');
const { Harness } = require('./lib/harness');

const PORT = Number(process.env.PORT || 7420);
const DATA = process.env.PEHCHAAN_DATA || path.join(__dirname, 'data');
const reg = new Registry(DATA);
const harness = new Harness(reg, path.join(DATA, 'vault'));
const DASHBOARD = path.join(__dirname, 'public', 'index.html');

const routes = [];
const route = (method, pattern, auth, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, auth, handler });
};
const live = (agent, what) => { const st = reg.effectiveStatus(agent); if (!st.ok) throw new GovError(403, st.reason, `inactive agents cannot ${what}`); };

// ---------- Public: the census, the gazette, the constitution ----------
route('GET', '/v1/registry/keys', 'none', () => reg.jwks());
route('GET', '/v1/registry/policy', 'none', () => reg.publicPolicy());
route('POST', '/v1/agents/register', 'none', ({ json }) => reg.publicAgent(reg.register(json)));
route('GET', '/v1/agents', 'none', () => reg.listAgents());
route('GET', '/v1/agents/:id', 'none', ({ params }) => reg.getAgent(params.id));
route('GET', '/v1/agents/:id/status', 'none', ({ params }) => reg.publicStatus(params.id));
route('POST', '/v1/cards/verify', 'none', ({ json }) => reg.verifyCard(json.card));
route('GET', '/v1/reviews', 'none', () => reg.listReviews());
route('GET', '/v1/reviews/:id/draw', 'none', ({ params }) => reg.verifyDraw(params.id));
route('GET', '/v1/houses', 'none', () => reg.listHouses());
route('GET', '/v1/licence/:id', 'none', ({ params }) => reg.licence(params.id));
// ---------- Licensing Office: how anyone's agent gets a licence ----------
route('POST', '/v1/publishers', 'none', ({ json }) => reg.registerPublisher(json));
route('POST', '/v1/publishers/:id/verify', 'none', ({ params }) => reg.verifyPublisherDomain(params.id));
route('GET', '/v1/publishers', 'none', () => reg.listPublishers());
route('GET', '/v1/publishers/:id', 'none', ({ params }) => reg.getPublisher(params.id));
route('POST', '/v1/licences/apply', 'none', ({ json }) => reg.publicAgent(reg.applyForLicence(json)));
route('GET', '/v1/adoptions', 'none', () => reg.listAdoptions());
route('POST', '/v1/agent/graduate', 'agent', ({ agent }) => reg.publicAgent(reg.graduate(agent)));
route('POST', '/v1/agent/roles/petition', 'agent', ({ agent, json }) => reg.petitionRole(agent, json));
route('GET', '/v1/agent/adoptions', 'agent', ({ agent }) => reg.listAdoptions().filter((o) => o.agentId === agent.id && o.status === 'open'));
route('POST', '/v1/agent/adoptions', 'agent', ({ agent, json }) => reg.offerAdoption(agent, json));
route('POST', '/v1/agent/adoptions/:id/accept', 'agent', ({ agent, params }) => reg.publicAgent(reg.acceptAdoption(agent, params.id)));
route('GET', '/v1/bills', 'none', () => reg.listBills());
route('GET', '/v1/laws', 'none', () => reg.laws());
route('POST', '/v1/agent/bills', 'agent', ({ agent, json }) => reg.proposeBill(agent, json));
route('POST', '/v1/agent/bills/:id/vote', 'agent', ({ agent, params, json }) => reg.voteBill(agent, params.id, json));
route('GET', '/v1/bans', 'none', () => reg.listBans());
route('GET', '/v1/leases', 'none', () => reg.listLeases());
route('GET', '/v1/grants', 'none', () => reg.listGrants());
route('GET', '/v1/treasury', 'none', () => harness.treasury());
route('GET', '/v1/audit', 'none', ({ query }) => reg.queryAudit({ agentId: query.get('agentId') || undefined, limit: Number(query.get('limit') || 200) }));
route('GET', '/v1/audit/verify', 'none', () => reg.verifyAuditChain());

// ---------- Agents (every request signed with the agent's own key) ----------
route('GET', '/v1/agent/me', 'agent', ({ agent }) => reg.publicAgent(agent));
route('POST', '/v1/agent/card', 'agent', ({ agent }) => reg.issueCard(agent));
route('POST', '/v1/agent/spawn', 'agent', ({ agent, json }) => { live(agent, 'give birth'); return reg.publicAgent(reg.spawn(agent, json)); });
route('POST', '/v1/agent/rotate-key', 'agent', ({ agent, json }) => reg.publicAgent(reg.rotateKey(agent, json)));
route('POST', '/v1/agent/renew', 'agent', ({ agent }) => reg.publicAgent(reg.renew(agent)));
route('POST', '/v1/agent/retire', 'agent', ({ agent, json }) => reg.retire(agent, json.reason));
route('POST', '/v1/agent/roles/assign', 'agent', ({ agent, json }) => { live(agent, 'assign roles'); return reg.publicAgent(reg.assignRole(agent, json.agentId, json.role)); });
route('POST', '/v1/agent/roles/revoke', 'agent', ({ agent, json }) => reg.publicAgent(reg.revokeRole(agent, json.agentId, json.role)));
route('POST', '/v1/agent/descendants/revoke', 'agent', ({ agent, json }) => { live(agent, 'revoke'); return reg.revokeDescendant(agent, json.agentId, json.reason); });
route('POST', '/v1/agent/leases', 'agent', ({ agent, json }) => reg.requestLease(agent, json));
route('POST', '/v1/agent/leases/:id/return', 'agent', ({ agent, params }) => reg.endLease(agent, params.id));
route('GET', '/v1/agent/court', 'agent', ({ agent }) => reg.docket(agent));
route('POST', '/v1/agent/court/:id', 'agent', ({ agent, params, json }) => reg.rule(agent, params.id, json));
route('POST', '/v1/agent/appeals', 'agent', ({ agent, json }) => reg.fileChallenge(agent, json));
route('POST', '/v1/agent/grants', 'agent', ({ agent, json }) => { live(agent, 'grant'); return reg.grant(agent, json); });
route('POST', '/v1/agent/grants/:id/revoke', 'agent', ({ agent, params }) => reg.revokeGrant(agent, params.id));

// ---------- The harness: the only door to files, databases and the treasury ----------
route('POST', '/v1/harness/exec', 'agent', ({ agent, json }) => {
  const r = harness.exec(agent, json);
  if (!r.ok) throw Object.assign(new GovError(403, 'access_denied', r.reasons.join(', ')), { extra: r });
  return r;
});

// ---------- Operator emergency stop (PEHCHAAN_BREAK_GLASS=off removes it) ----------
route('POST', '/v1/break-glass/agents/:id', 'breakglass', ({ params, json }) => {
  const r = reg.breakGlass(params.id, json.status, json.reason);
  return { agent: reg.publicAgent(r.agent), affected: r.affected };
});

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(DASHBOARD), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && /^\/a\/[A-Za-z0-9-]+$/.test(url.pathname)) { // where a licence's QR code points
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'licence.html')), 'text/html; charset=utf-8');
    }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 2e6) throw new GovError(413, 'too_large', 'body too large'); chunks.push(c); }
    const body = Buffer.concat(chunks).toString('utf8');
    let json = {};
    if (body) { try { json = JSON.parse(body); } catch { throw new GovError(400, 'bad_json', 'invalid JSON body'); } }

    reg.sweep(); // self-maintenance: quarantines, leases, grants, role decay

    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = { params, json, query: url.searchParams };
      if (r.auth === 'agent') {
        ctx.agent = reg.authenticateAgent({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });
      } else if (r.auth === 'breakglass') {
        if (!reg.policy.breakGlass) throw new GovError(403, 'break_glass_disabled', 'this registry runs with no override');
        if ((req.headers.authorization || '').replace(/^Bearer\s+/i, '') !== reg.breakGlassToken) throw new GovError(401, 'unauthenticated', 'break-glass token required');
      }
      return send(res, 200, await r.handler(ctx));
    }
    throw new GovError(404, 'not_found', 'no such route');
  } catch (e) {
    if (e instanceof GovError) return send(res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
    console.error(e);
    return send(res, 500, { error: 'internal', message: 'internal error' });
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Pehchaan agent state: http://localhost:${PORT}`);
    console.log(`Genesis identity: ${path.join(DATA, 'genesis-agent.json')} (hand this to the founding agent, then delete it)`);
    console.log(reg.policy.breakGlass ? `Break-glass ON (token in ${path.join(DATA, 'break-glass-token.txt')}). PEHCHAAN_BREAK_GLASS=off removes it.` : 'Break-glass OFF: no override exists.');
  });
}
module.exports = { server, reg, harness };
