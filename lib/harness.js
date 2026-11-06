// The Harness: the civil service of the agent state.
// It is the ONLY path from an agent to a real resource. It holds the connectors and credentials,
// asks the registry (Policy Decision Point) for every single operation, and only then acts.
// Agents never receive file handles, database credentials or payment keys: only results.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { GovError } = require('./registry');

const MAX_BYTES = 1_000_000;

class Harness {
  constructor(registry, vaultDir) {
    this.reg = registry;
    this.root = path.resolve(vaultDir);
    this.fsRoot = path.join(this.root, 'fs');
    this.kvRoot = path.join(this.root, 'kv');
    this.ledgerFile = path.join(this.root, 'ledger.json');
    if (!fs.existsSync(this.root)) this.#seed();
    this.connectors = { fs: this.#fs.bind(this), kv: this.#kv.bind(this), ledger: this.#ledger.bind(this) };
  }

  /** Every resource operation in the state goes through here. */
  exec(agent, { resource, op, args = {} }) {
    const amount = op === 'transfer' ? Number(args.amount) : 0;
    const target = args.to ?? args.key ?? null; // what the operation is aimed at, for purpose-bound leases
    const d = this.reg.authorize(agent, { resource, op, amount, target });
    const receipt = this.reg.receipt(agent, d, { resource, op });
    if (d.decision !== 'allow') return { ok: false, ...d, receipt };
    const info = this.reg.resourceInfo(resource);
    try {
      const result = this.connectors[info.type](agent, resource, op, args);
      return { ok: true, ...d, receipt, result };
    } catch (e) {
      this.reg.audit('harness.error', agent.id, agent.id, { resource, op, error: e.code || e.message });
      if (e instanceof GovError) throw e;
      throw new GovError(400, 'operation_failed', e.message);
    }
  }

  // ---------------- File system connector ----------------
  #resolve(resource) {
    const rel = resource.slice('fs:'.length);
    const abs = path.resolve(this.fsRoot, rel);
    if (abs !== this.fsRoot && !abs.startsWith(this.fsRoot + path.sep)) throw new GovError(400, 'path_escape', 'path escapes the state file system');
    return abs;
  }
  #fs(agent, resource, op, args) {
    const p = this.#resolve(resource);
    switch (op) {
      case 'read': {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new GovError(404, 'not_found', 'no such file');
        if (fs.statSync(p).size > MAX_BYTES) throw new GovError(413, 'too_large', 'file too large');
        return { content: fs.readFileSync(p, 'utf8') };
      }
      case 'write': {
        const content = String(args.content ?? '');
        if (Buffer.byteLength(content) > MAX_BYTES) throw new GovError(413, 'too_large', 'content too large');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return { bytes: Buffer.byteLength(content) };
      }
      case 'list': {
        if (!fs.existsSync(p)) return { entries: [] };
        if (!fs.statSync(p).isDirectory()) throw new GovError(400, 'not_a_directory', 'not a directory');
        return { entries: fs.readdirSync(p, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
      }
      case 'delete': {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new GovError(404, 'not_found', 'no such file');
        fs.unlinkSync(p);
        return { deleted: true };
      }
      default: throw new GovError(400, 'bad_op', `fs does not support ${op}`);
    }
  }

  // ---------------- Key-value database connector ----------------
  #kv(agent, resource, op, args) {
    const file = path.join(this.kvRoot, resource.split(':')[1] + '.json');
    const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
    switch (op) {
      case 'list': return { keys: Object.keys(db) };
      case 'read': {
        if (!(args.key in db)) throw new GovError(404, 'not_found', 'no such key');
        return { key: args.key, value: db[args.key] };
      }
      case 'write': {
        if (!args.key) throw new GovError(400, 'invalid', 'key is required');
        db[args.key] = args.value; save(); return { key: args.key, written: true };
      }
      case 'delete': { delete db[args.key]; save(); return { key: args.key, deleted: true }; }
      default: throw new GovError(400, 'bad_op', `kv does not support ${op}`);
    }
  }

  // ---------------- Treasury connector (a stand-in for a payment rail) ----------------
  #ledger(agent, resource, op, args) {
    const L = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8'));
    switch (op) {
      case 'read': return { balance: L.balance, recent: L.history.slice(-10).reverse() };
      case 'transfer': {
        const amount = Number(args.amount);
        if (!(amount > 0)) throw new GovError(400, 'invalid', 'amount must be positive');
        if (!args.to) throw new GovError(400, 'invalid', 'to is required');
        if (amount > L.balance) throw new GovError(409, 'insufficient_funds', 'treasury balance too low');
        const tx = { id: 'tx_' + (L.history.length + 1), at: new Date().toISOString(), by: agent.id, to: String(args.to), amount, memo: String(args.memo || '').slice(0, 200) };
        L.balance -= amount; L.history.push(tx);
        fs.writeFileSync(this.ledgerFile, JSON.stringify(L, null, 2));
        this.reg.audit('treasury.transfer', agent.id, agent.id, { txId: tx.id, to: tx.to, amount, balance: L.balance });
        return { tx, balance: L.balance };
      }
      default: throw new GovError(400, 'bad_op', `ledger does not support ${op}`);
    }
  }

  // ---------------- Initial state of the world ----------------
  #seed() {
    const w = (rel, content) => { const p = path.join(this.fsRoot, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
    w('public/notice.md', '# Notice\nAll access to state resources passes through the harness. Every operation is published in the gazette.\n');
    w('finance/invoices/inv-2291.json', JSON.stringify({ vendor: 'vendor-7', amount: 5000, po: 'PO-7781', status: 'unpaid' }, null, 2));
    w('finance/invoices/inv-2292.json', JSON.stringify({ vendor: 'vendor-9', amount: 1200, po: 'PO-7790', status: 'unpaid' }, null, 2));
    w('health/weekly-report.md', '# Weekly report\nNo incidents.\n');
    fs.mkdirSync(path.join(this.fsRoot, 'home'), { recursive: true });
    fs.mkdirSync(this.kvRoot, { recursive: true });
    fs.writeFileSync(path.join(this.kvRoot, 'customers.json'), JSON.stringify({
      'cust-001': { name: 'Asha Rao', tier: 'gold' }, 'cust-002': { name: 'Vikram Shah', tier: 'silver' }, 'cust-003': { name: 'Meera Iyer', tier: 'gold' },
    }, null, 2));
    fs.writeFileSync(this.ledgerFile, JSON.stringify({ balance: 1_000_000, history: [] }, null, 2));
  }

  treasury() { const L = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8')); return { balance: L.balance, transfers: L.history.length }; }
}

module.exports = { Harness };
