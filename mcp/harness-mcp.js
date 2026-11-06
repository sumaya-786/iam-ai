#!/usr/bin/env node
// MCP server (stdio) that gives an LLM agent its tools: everything goes through the Pehchaan harness.
// The model never sees its private key or any resource credential; this process signs on its behalf.
//
//   PEHCHAAN_URL=http://localhost:7420 PEHCHAAN_IDENTITY=./agent.json node mcp/harness-mcp.js
//
// Claude Code:  claude mcp add pehchaan -e PEHCHAAN_IDENTITY=/abs/agent.json -- node /abs/mcp/harness-mcp.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { PehchaanAgent } = require('../sdk/agent');

const URL_ = process.env.PEHCHAAN_URL || 'http://localhost:7420';
const IDENTITY = process.env.PEHCHAAN_IDENTITY;
if (!IDENTITY) { process.stderr.write('PEHCHAAN_IDENTITY (path to identity json) is required\n'); process.exit(1); }
const agent = PehchaanAgent.fromFile(URL_, IDENTITY);
const persist = () => fs.writeFileSync(IDENTITY, JSON.stringify(agent.toJSON(), null, 2)); // after key rotation

const str = { type: 'string' };
const TOOLS = [
  { name: 'whoami', description: 'Your identity card: Agent ID, roles, clearance, trust, active leases, home directory.', inputSchema: { type: 'object', properties: {} },
    run: async () => { const m = await agent.me(); return { id: m.formattedId, name: m.name, roles: m.effectiveRoles, clearance: m.clearance, trust: m.trust, status: m.status, home: m.home.replace(/^fs:/, ''), activeLeases: m.activeLeases.map((l) => ({ id: l.id, resource: l.resource, ops: l.ops, until: l.expiresAt })) }; } },
  { name: 'list_files', description: 'List a directory in the state file system, e.g. "public", "finance/invoices", or your home.', inputSchema: { type: 'object', properties: { path: str }, required: ['path'] },
    run: async ({ path: p }) => agent.listFiles(p) },
  { name: 'read_file', description: 'Read a file through the harness.', inputSchema: { type: 'object', properties: { path: str }, required: ['path'] },
    run: async ({ path: p }) => agent.readFile(p) },
  { name: 'write_file', description: 'Write a file through the harness (your home directory is always writable).', inputSchema: { type: 'object', properties: { path: str, content: str }, required: ['path', 'content'] },
    run: async ({ path: p, content }) => (await agent.writeFile(p, content)).result },
  { name: 'delete_file', description: 'Delete a file through the harness.', inputSchema: { type: 'object', properties: { path: str }, required: ['path'] },
    run: async ({ path: p }) => (await agent.deleteFile(p)).result },
  { name: 'access_resource', description: 'Operate on any state resource, e.g. resource "db:customers" op "read" args {key}, or "ledger:treasury" op "transfer" args {to, amount, memo}. Critical resources need an active lease.',
    inputSchema: { type: 'object', properties: { resource: str, op: str, args: { type: 'object' } }, required: ['resource', 'op'] },
    run: async ({ resource, op, args }) => (await agent.exec(resource, op, args || {})).result },
  { name: 'request_lease', description: 'Petition the court for time-boxed privileged access to a critical resource. Judges are drawn by lot from other houses. Transfer leases are purpose-bound: name the payees and maxTotal; the harness refuses anything else. Every lease may be audited after it ends.',
    inputSchema: { type: 'object', properties: { resource: str, ops: { type: 'array', items: str }, seconds: { type: 'number' }, justification: str, payees: { type: 'array', items: str }, maxTotal: { type: 'number' }, keys: { type: 'array', items: str } }, required: ['resource', 'ops', 'justification'] },
    run: async ({ resource, ops, seconds, justification, payees, maxTotal, keys }) => {
      const r = await agent.requestLease(resource, ops, { seconds, justification, constraints: { payees, maxTotal, keys } });
      return { leaseId: r.lease.id, reviewId: r.review.id, status: r.lease.status, panelSize: r.review.panelSize, constraints: r.lease.constraints };
    } },
  { name: 'court_docket', description: 'Cases you were drawn by lot to judge. Appeals include the evidence of what the lessee actually did. Judge on the merits: approvers of leases later overturned on appeal lose trust and can be disbarred.', inputSchema: { type: 'object', properties: {} },
    run: async () => agent.docket() },
  { name: 'court_rule', description: 'Cast your sealed vote on a case from your docket (approve = grant the lease, or uphold the appeal).', inputSchema: { type: 'object', properties: { reviewId: str, approve: { type: 'boolean' }, note: str }, required: ['reviewId', 'approve'] },
    run: async ({ reviewId, approve, note }) => { const r = await agent.rule(reviewId, approve, note); return { status: r.status, votesCast: r.votesCast }; } },
  { name: 'file_appeal', description: 'Challenge another house\'s granted lease if you believe it was misused or wrongly approved. You stake 10 trust: returned plus a reward if upheld, lost if dismissed.', inputSchema: { type: 'object', properties: { leaseId: str, grounds: str }, required: ['leaseId', 'grounds'] },
    run: async ({ leaseId, grounds }) => { const r = await agent.appeal(leaseId, grounds); return { reviewId: r.id, status: r.status, evidenceItems: r.evidence }; } },
  { name: 'propose_law', description: 'Propose changing one of the amendable rules of the constitution (see GET /v1/laws). Needs trust ≥ 70. Passes only if 2/3 of all houses vote yes.', inputSchema: { type: 'object', properties: { path: str, value: { type: 'number' }, rationale: str }, required: ['path', 'value', 'rationale'] },
    run: async ({ path: p, value, rationale }) => { const b = await agent.proposeBill(p, value, rationale); return { billId: b.id, rule: b.label, from: b.from, to: b.to, needed: b.needed, of: b.electorate.length }; } },
  { name: 'vote_law', description: 'Vote on a bill. A house head casts its family\'s single vote; a graduated independent casts its publisher\'s one ballot in the Commons primary.', inputSchema: { type: 'object', properties: { billId: str, yes: { type: 'boolean' } }, required: ['billId', 'yes'] },
    run: async ({ billId, yes }) => { const b = await agent.vote(billId, yes); return { status: b.status, yes: b.votes.filter((v) => v.yes).length, needed: b.needed }; } },
  { name: 'spawn_agent', description: 'Give birth to a child agent with a subset of your roles. Its identity is saved next to yours; you never see its key.',
    inputSchema: { type: 'object', properties: { name: str, roles: { type: 'array', items: str }, purpose: str }, required: ['name'] },
    run: async ({ name, roles, purpose }) => {
      const { child, record } = await agent.spawn({ name, roles: roles || [], purpose: purpose || '' });
      const file = path.join(path.dirname(IDENTITY), `agent-${record.id}.json`);
      fs.writeFileSync(file, JSON.stringify(child.toJSON(), null, 2));
      return { id: record.formattedId, roles: record.effectiveRoles, identityFile: path.basename(file) };
    } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pehchaan-harness', version: '0.2.0' } });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
      try {
        const out = await tool.run(params.arguments || {});
        persist();
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        const reasons = e.data?.reasons ? ` [${e.data.reasons.join(', ')}]` : '';
        return reply({ isError: true, content: [{ type: 'text', text: `${e.message}${reasons}` }] });
      }
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
