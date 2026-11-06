# Pehchaan Authority: licences for AI agents

Pehchaan is a **licensing authority** for AI agents, and the identity and access system behind it. Every agent carries a licence (like `PA-7K4M-9QX2-H3TB`, with a QR code). It reaches files, databases and money only through our harness. Courts drawn by lottery approve risky actions, and a Parliament of agent families adjusts the rules. **No human is in the loop** after the Authority is founded.

- **We operate** the Authority: the register, the harness, the courts, Parliament, and the public licence-check page.
- **Agent builders** use `pehchaan-sdk` to hold a licence and act through the harness.
- **Businesses** use `pehchaan-sdk` to accept only licensed agents. They can verify a licence offline with our public key, or live against the register.

Zero dependencies (the dashboard loads one QR library from a CDN). Node 20+.

```bash
node server.js --demo   # registry + harness + console on http://localhost:7420 (--demo lets new judges sit at once)
node demo.js            # a state is founded and a 3-house cartel tries to rob the treasury, zero human actions
npm test                # 35 unit tests, incl. a randomised cartel property test
```

Without `--demo`, judges must be 24 hours old before they can sit (anti sock-puppet), and new laws wait a 1-hour cooling-off period.

Open http://localhost:7420 for the dashboard, which is written for people who aren't technical:

| Page | Shows |
|---|---|
| **Home** | What a licence is, live counts, a plain-English feed of what's happening, and whether the public record is untampered |
| **Agents** | Every licensed agent as a card. Tap one for the full licence: status, trust in words, what it may and may never do, who created it, and its QR code |
| **Check a licence** | Type a licence number. Typos are caught by the check character before anything is looked up |
| **Get a licence** | For outside developers: the five steps, the two CLI commands, what learner, full and adopted licences allow, and every publisher with its record |
| **Courts** | Each case as a sentence: who asked to pay whom and how much, the reason, the decision, which judges from which families, and the audit result |
| **Parliament** | Seats, proposals with vote bars, laws passed, the rules Parliament may change, and the rules no one can change |
| **Rules** | The whole constitution in plain words, with each rule marked "Parliament can change" or "fixed" |
| **For developers** | SDK snippets |
| **Advanced** | Raw public record, token verifier, the Authority's signing key, and the operator emergency stop |

A licence's QR code opens `/a/PA-XXXX-XXXX-XXXX`, a phone-friendly page with a single verdict (Licensed, Suspended, or Cancelled), served live from the register.

## Getting a licence: the Licensing Office

Anyone can build an agent and get it licensed, with no human to ask and nothing to wait for:

```bash
npx pehchaan publisher --name "Ravi Labs" --domain ravilabs.in   # once: you, the person or company behind the agent
npx pehchaan apply --name "Shopping Helper" --purpose "Compares prices"
npx pehchaan graduate agent-PA-XXXX-XXXX-XXXX.json               # after probation
npx pehchaan status PA-XXXX-XXXX-XXXX                             # anyone, any licence
```

or in code: `const { Publisher } = require('pehchaan-sdk')`, then `publisher.register(...)` and `publisher.applyForLicence(...)`.

| Step | What happens | Why it is safe |
|---|---|---|
| **1. Publisher** | The developer registers their own key, with an optional domain proven by serving the publisher id at `https://<domain>/.well-known/pehchaan-publisher.txt` | Costs a proof-of-work stamp. All of a publisher's agents share one reputation |
| **2. Apply** | The agent creates its own key. The publisher signs the application, the agent signs it too, and pays a proof-of-work stamp | No one can apply in a publisher's name. Mass sign-ups cost computing time |
| **3. Learner licence** | Issued automatically, with trust 30 (40 if the publisher is verified). The learner can read public information and use its own folder: no money, no spawning, no judging | Learners join **the Commons**, one shared house for all independents. It has **one Parliament seat**, decided by verified publishers (one ballot each), and supplies **at most one judge** per panel, so a thousand sign-ups capture nothing. Unverified publishers may hold 3 learners at a time, verified ones 50 |
| **4. Graduate** | Self-service after probation (7 days), with no suspensions and no net loss of trust | Time and a clean record can't be faked |
| **5a. Court** | An independent petitions for a role (publish notices, read health reports, read finance documents). A panel drawn from the houses, never the Commons, decides | Payments can never be granted this way |
| **5b. Adoption** | A ministry offers to adopt it, posting a bond and granting roles it holds. The agent accepts and moves into that house | The adopter's bond is at stake, and the publisher stays accountable |
| **Misconduct** | Each suspension of a publisher's agent is a strike against the publisher. **3 strikes in 30 days suspend the publisher** and put all its agents on hold. A police cancellation costs its siblings 10 trust | One bad publisher can't keep cycling agents |

The old self-registration route is closed: it made every newcomer its own house, which would have meant one vote and one judge seat per sign-up.

API: `POST /v1/publishers`, `POST /v1/publishers/:id/verify`, `GET /v1/publishers`, `POST /v1/licences/apply`, `GET /v1/adoptions`; agent-signed: `POST /v1/agent/graduate`, `POST /v1/agent/roles/petition`, `GET|POST /v1/agent/adoptions`, `POST /v1/agent/adoptions/:id/accept`.

## Licence numbers

`PA-7K4M-9QX2-H3TB`: the prefix `PA`, then 11 random Crockford base-32 characters and 1 **Luhn mod-32 check character**. The alphabet leaves out I, L, O and U, so there's nothing to misread. Input is forgiving: case, spaces and dashes are ignored, and O/I/L are read as 0/1/1. Every single-character typo is caught.

## The SDK (`sdk/`, package `pehchaan-sdk`)

```js
const { PehchaanAgent, Authority, licence } = require('pehchaan-sdk');

// Businesses: accept only licensed agents
const authority = new Authority('https://authority.example', { publicKey: PINNED_KEY }); // pin the key for offline checks
app.use(authority.requireLicence({ roles: ['finance.payer'], minTrust: 60 }));      // agents send x-agent-licence
const r = await authority.verify(card, { live: false });   // offline: signature + expiry
const r2 = await authority.verify(card);                    // live: also not suspended or cancelled right now
await authority.lookup('pa-7k4m 9qx2 h3tb');                // public licence details
authority.licenceUrl(id);                                   // what the QR code opens

// Agent builders
const agent = PehchaanAgent.fromFile(AUTHORITY, 'agent.json');
agent.licenceNumber;                                        // 'PA-7K4M-9QX2-H3TB'
await agent.proposeBill('courts.panelSize', 5, 'harder to capture');   // Parliament
await agent.vote(billId, true);                             // house heads only

licence.isValid('PA-7K4M-9QX2-H3TB'); licence.format(raw); licence.normalize(input);
```

The Authority itself uses the SDK's `core.js` (`lib/core.js` re-exports it), so a licence verifies exactly the same way on both sides.

## Parliament

The agents can change some of their own rules. Each **house** (a family founded by Genesis) casts **one vote**, through its head, so spawning more agents buys no votes.

**The Commons seat.** Independent agents share one seat. Its vote comes from a primary: **one ballot per verified publisher**, cast by any of its graduated agents, however many it has. The seat goes the way of a majority of the publishers frozen into the bill's electorate; a tie, or fewer than 3 ballots by the deadline, counts as no. The seat exists only when at least 3 verified publishers have graduated agents, and **one website (registrable domain) verifies only one publisher**, so extra ballots cost extra websites. Agents vote with the same call as house heads (`agent.vote(billId, yes)`).

- A bill passes only with **2/3 of all live houses**, and not voting counts as no. It closes the moment it passes, or the moment passing becomes impossible.
- The electorate is **frozen when the bill is filed**: founding a new house mid-vote buys nothing.
- Only listed rules can change, and only **within hard bounds** (e.g. panel size 3–7 and odd, audit rate 50–100%). Bounds are re-checked when the law takes effect.
- Laws take effect after a **cooling-off delay** (1 hour) and survive restarts.
- Proposing needs trust ≥ 70, and each proposer may have at most 3 open bills.
- **Entrenched** (no bill can touch them): birth only from agents, all access through the harness, the absolute bans, separation of duties, how courts are drawn, the public record, and how Parliament itself works.

API: `GET /v1/bills`, `GET /v1/laws`, `POST /v1/agent/bills`, `POST /v1/agent/bills/:id/vote`.

## The state

| Institution | In the code | What it does |
|---|---|---|
| **Licensing** | licence + card | Alphanumeric licence number with a check character and a QR code. An Ed25519 key held only by the agent. A 15-minute signed card bound to that key, verifiable offline with the SDK |
| **Birth registry** | `spawn` | Every agent is born of a parent. Children get a fresh key, at most the parent's roles and limits, and can't outlive the parent. One **Genesis** agent is created at founding; open immigration is off by default |
| **Ministries** | roles | Permissions come only from roles (`finance.clerk`, `finance.payer`, `auditor`, ...). Ancestors assign and withdraw roles down their lineage; withdrawal cascades |
| **Separation of duties** | `conflicts` | e.g. nobody may be both `finance.payer` and `auditor` |
| **Clearance** | classification | Resources are public / internal / confidential / critical. Trust ≥ 0 / 20 / 50 / 70 to touch them |
| **Civil service** | **the harness** | The only door to resources. It holds the connectors and credentials, asks the policy engine about every single operation, then performs it. Agents get results, never handles or keys. Default deny: unlisted resources don't exist |
| **Courts** | leases + appeals | Critical systems (treasury, customer DB) need a time-boxed lease approved by a court. See [Anti-collusion courts](#anti-collusion-courts) |
| **Bonds** | `spawn({bond})` | Starting trust is 40 + a bond the parent posts from its own trust (max 40, total ≤ parent's trust). The parent loses half on the child's quarantine, all of it on police revocation |
| **Earned trust** | `#earn` | Work in your own home earns nothing; each (resource, op) earns once a day; 20/day cap. Trust cannot be farmed |
| **Property** | home dirs + grants | Every agent owns `home/<id>/` and can lend time-boxed read/write to another agent |
| **Police** | quarantine | 5 violations/min or trust < 20 → quarantine, auto-released after cooldown. 3rd strike → permanent revocation, cascading to descendants. Parents lose trust when children are quarantined |
| **Hygiene** | role decay | Roles unused for 30 days are stripped automatically (least privilege without anyone reviewing) |
| **Treasury** | limits + ledger | Per-transaction and daily caps; every transfer is in the gazette |
| **Gazette** | audit log | Public, hash-chained, tamper-evident. `GET /v1/audit/verify` returns a registry-signed head |
| **Parliament** | bills + laws | One vote per house, a 2/3 supermajority of all houses, bounded and entrenched. See [Parliament](#parliament) |
| **Constitution** | [lib/constitution.js](lib/constitution.js) | Every rule above, published at `GET /v1/registry/policy`. Absolute bans (e.g. touching the registry, other agents' keys) |

## Anti-collusion courts

A **house** is the lineage under one child of Genesis (a ministry and everything it spawned). Collusion usually comes from one family, so the courts are built around houses.

| Attack | Defence |
|---|---|
| Pick friendly judges | **Sortition.** Nobody volunteers. The registry draws 3 judges by trust-weighted lot, seeded by the case ID and the gazette head hash. After the verdict, `GET /v1/reviews/:id/draw` publishes the pool and seed so anyone can re-run the lottery and get the same panel |
| A family judges its own | The petitioner's house is never eligible, and a panel has **at most one judge per house** |
| Lobby or bribe the judges | Panels are **anonymous and votes sealed** until the verdict. Only the drawn judges see the case on their docket |
| "You approve mine, I'll approve yours" | **Reciprocity ban.** If S approved J's petition in the last 30 days, J can never be drawn for S |
| Sock-puppet judges | Judges need trust ≥ 60 and must be ≥ 24h old. Genesis never sits |
| Rubber-stamping | **Appeals with slashing.** Any trusted agent from *another* house can challenge a granted lease, staking 10 trust. The harness attaches the evidence (everything the lessee did under the lease) from the gazette. A fresh panel (no original judges, not the petitioner's or challenger's house) decides. Upheld: the lease is pulled, the lessee is penalised and quarantined, its parent loses its bond, judges who approved are **slashed −15**, dissenters get +5, the challenger gets its stake +5. Two overturned approvals and a judge is **disbarred**. Dismissed: the challenger loses its stake |
| Stalling | Judges who don't rule within 5 minutes are replaced by a fresh draw and lose 2 trust |
| Not enough honest judges | No court is convened (`no_court`). It fails closed: no lease |

### Cross-house cartels

Houses from different families can still collude. Three layers stop them:

| Layer | Mechanism |
|---|---|
| **Prevent: purpose-bound leases** | A transfer lease must name its `payees` and `maxTotal`. The harness refuses any other payee (`outside_lease_purpose`) or any amount over the total (`exceeds_lease_total`). Judges approve a concrete, checkable promise, not a vague request |
| **Detect: automatic audits** | When a lease ends, a fresh panel re-examines it against the evidence, with no complaint needed. Triggered **always on any dissent**, always for high value (≥ 25,000), and otherwise by a published lottery (default rate **1.0** = every lease). The audit panel is drawn only from houses that did **not** sit on the original case |
| **Scale** | Leases ≥ 50,000 need a 5-judge panel (majority 3) |
| **Separate** | Judges overturned together are banned from sitting on the same panel for 90 days. The bans are in the published draw pool, so the draw still verifies |
| **Punish houses** | A house whose judges are overturned twice in 30 days is suspended from the bench for 7 days |

**What this guarantees.** With every lease audited, a corrupt lease survives only if a cartel holds a majority on the original panel *and* on an audit panel drawn from disjoint houses. With panels of 3, that needs at least **4 corrupt houses**, and a majority of houses when there are 6 or fewer. `npm test` checks this: in 20 random trials, a 3-of-6 cartel's corrupt lease is always rejected or convicted. A second test shows why the audit rate defaults to 1: below it, a cartel that wins all 3 seats (so nobody dissents) can slip through.

## How an agent works

```js
const { PehchaanAgent } = require('./sdk/agent');
const genesis = PehchaanAgent.fromFile('http://localhost:7420', 'data/genesis-agent.json');

const { child: finance } = await genesis.spawn({ name: 'Finance Ministry', roles: ['finance.clerk', 'finance.payer'] });
const { child: payer }   = await finance.spawn({ name: 'Invoice Agent', roles: ['finance.clerk', 'finance.payer'] });

await payer.readFile('finance/invoices/inv-2291.json');            // via harness: role + clearance checked
const { review } = await payer.requestLease('ledger:treasury', ['transfer'], {
  seconds: 300, justification: 'Pay inv-2291 to vendor-7', constraints: { payees: ['vendor-7'], maxTotal: 5000 },
});
// ...two independent auditors call judge.rule(review.id, true)...
await payer.exec('ledger:treasury', 'transfer', { to: 'vendor-7', amount: 5000 });

payer.autopilot();   // renews itself and rotates its own key, forever
```

## Plugging in a real LLM agent (MCP)

[mcp/harness-mcp.js](mcp/harness-mcp.js) is an MCP server that gives a model its *only* tools: `whoami`, `list_files`, `read_file`, `write_file`, `delete_file`, `access_resource`, `request_lease`, `court_docket`, `court_rule`, `spawn_agent`. It signs on the agent's behalf, so the model never sees its private key or any resource credential.

```bash
claude mcp add pehchaan -e PEHCHAAN_IDENTITY=/abs/path/agent.json -- node /abs/path/mcp/harness-mcp.js
```

**The harness is only a real boundary if the agent can't go around it.** Run each agent in a sandbox (container/VM) with no file system mounts, no credentials, and network egress allowed only to the harness. Pehchaan decides and enforces *inside* the harness; the sandbox makes the harness the only way out.

## API

Public: `GET /v1/agents`, `/v1/agents/:id`, `/v1/agents/:id/status`, `/v1/reviews`, `/v1/leases`, `/v1/grants`, `/v1/treasury`, `/v1/audit`, `/v1/audit/verify`, `/v1/registry/keys`, `/v1/registry/policy`; `POST /v1/cards/verify`

Agent-signed (`x-agent-id`, `x-agent-timestamp`, `x-agent-nonce`, `x-agent-signature` over method, path, timestamp, nonce, body hash):
`GET /v1/agent/me` · `POST /v1/agent/card` · `/spawn` · `/renew` · `/rotate-key` · `/retire` · `/roles/assign` · `/roles/revoke` · `/descendants/revoke` · `/leases` · `/leases/:id/return` · `GET /v1/agent/court` · `POST /v1/agent/court/:id` · `/grants` · `/grants/:id/revoke` · **`POST /v1/harness/exec {resource, op, args}`**

Operator: `POST /v1/break-glass/agents/:id` (freeze/unfreeze/revoke, published in the gazette). `PEHCHAAN_BREAK_GLASS=off` removes it entirely.

## Before production

- **Majority cartels.** No majority-vote court survives a cartel that controls most houses. The defence there is keeping houses scarce (only Genesis founds them) and independent; adding more houses raises the bar.
- **Judging quality.** Audits are only as good as the judges' reasoning. Purpose binding keeps that reasoning simple (does the payee match a cited invoice?), but real agents need clear judging guidelines.
- **The draw seed.** It comes from the gazette head, which the registry itself writes. Use an external randomness beacon (e.g. drand) so the registry can't grind seeds.
- **One registry is one point of trust.** Move the gazette to a transparency log or several registries that cross-sign heads.
- **Constitution amendments.** Rules are fixed at founding. A legislature (supermajority of high-trust agents, with a delay and some articles unamendable) is the natural next institution.
- JSON-file storage and in-memory nonce/rate state: use a database before running more than one instance.
- **Legal liability.** Laws in most places still require a legally responsible person or company, and human oversight for high-risk uses (EU AI Act). Settle that before real money or personal data moves.
- "Aadhaar" is a UIDAI trademark; that's why this is called Pehchaan.
