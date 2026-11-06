# CONTEXT: Pehchaan Authority

This file is the project's memory: **what** was built, **how** it works, and **why** each decision was made, in the order the product evolved. Read it before changing anything. The user-facing explanation lives in [README.md](README.md). A plain-language guide for non-technical readers is in Claude Docs: [Pehchaan Authority: A Plain-Language Guide](https://claude.ai/artifact/34gpU8XbEyiiEnJNPjQJH9).

Status as of 2026-11-06: working prototype. 35 unit tests pass (`npm test`), and the end-to-end demo passes on repeated runs (`node demo.js` against `node server.js --demo`). Nothing is deployed and the SDK isn't published to npm.

---

## 1. What it is

Pehchaan ("identity") is an **identity and access management (IAM) system for AI agents, run as a self-governing state**, offered as a **licensing authority**:

- Every agent holds a **licence** (`PA-7K4M-9QX2-H3TB`, with a QR code) and its own Ed25519 key.
- Agents reach files, databases and money **only through the harness** (the gate), which checks every operation.
- Risky actions need a **court** of agents drawn by lottery. Every granted permission is **audited** afterwards.
- **Police** rules suspend and cancel automatically. **Parliament** lets agents amend bounded rules.
- Everything is written to a **hash-chained public record**.
- **No human is in the loop** after founding, except an optional operator emergency stop that can be switched off.
- We are the Authority. Developers license agents with the SDK or CLI, and businesses verify agents with the SDK.

Zero runtime dependencies (Node 20+). The dashboard loads one QR library from cdnjs.

---

## 2. How the product evolved (requests → decisions)

| # | User asked for | What was built | Why |
|---|---|---|---|
| 1 | "Aadhaar card for AI agents… full governance" | Agent ID with a checksum, Ed25519 keys, signed short-lived cards, policy engine, audit log, dashboard | Identity alone is useless without accountability and enforcement. Named **Pehchaan** because "Aadhaar" is a UIDAI trademark |
| 2 | "No human intervention… once an agent is born it has to be self-sustaining" | Removed human principals and approvals. Added trust scores, peer review, auto-quarantine, self-renewal, key rotation | Governance has to come from rules and other agents, not people. A break-glass stop was kept as an operator option because rule bugs need an off switch (`PEHCHAAN_BREAK_GLASS=off` removes it) |
| 3 | "Complete IAM… one agent can give birth to another… access only through harness… like a government" | Genesis and lineage (houses), roles (ministries), clearance levels, the harness as sole resource gateway, leases (courts), grants, role decay, MCP adapter | A government metaphor maps cleanly onto IAM: citizenship = identity, ministries = roles, civil service = the policy enforcement point, courts = just-in-time privileged access |
| 4 | "Anti-collusion courts" | Sortition (verifiable lottery), one judge per house, never the petitioner's house, sealed panels and votes, reciprocity ban, appeals with stakes, slashing, disbarment, no-show replacement, bonds, anti-farming trust rules | Self-selected reviewers collude. Each attack (friends, family, lobbying, favours, sock puppets, rubber-stamping, trust farming) gets a specific defence |
| 5 | "Cross-house cartels" | Purpose-bound leases (payees + maxTotal, enforced by the harness), automatic audits on disjoint houses (rate 1.0 by default), larger panels for big leases, co-overturned judge bans, house bench suspension | A property test showed that at audit rate below 1, a cartel capturing all 3 seats (no dissent) escapes. Auditing every lease forces a cartel to win two disjoint draws, which needs ≥ 4 corrupt houses |
| 6 | "Dashboard simple for non-tech; legislature; SDK so we become the licensing authority; alphanumeric ID; QR" | Plain-language dashboard, Parliament of houses, `pehchaan-sdk` (Authority verifier, agent client), `PA-` IDs with a Luhn mod-32 check character, QR licence page `/a/:id` | The product must be legible to non-engineers, ownable as a business, and checkable by anyone with a phone |
| 7 | "If some random guy creates an agent, how does it get a licence?" → "implement it" | Licensing Office: publishers (key + optional proven domain), applications (publisher signature + agent proof + proof of work), learner licences in **the Commons**, graduation, court role petitions, adoption, publisher strikes, CLI | The old open-registration path made every newcomer its own house (a vote and a judge seat per sign-up). Outsiders now share one house and carry publisher accountability |
| 8 | "A Parliament voice for independents" + "full document in easy language" | Commons seat decided by a primary with one ballot per verified publisher, one website per publisher, and the plain-language guide in Claude Docs | Independents deserved a voice without reopening the Sybil hole: ballots count publishers, not agents, and verified domains are scarce |

---

## 3. Architecture

```
server.js                HTTP server: routes, auth (agent signatures / break-glass), sweep() on every request
lib/constitution.js      EVERY rule (published at GET /v1/registry/policy). Edit rules here, not in code.
lib/registry.js          The PDP and state: identity, lineage, roles, trust, police, courts, audits,
                         Parliament, Licensing Office, read models, hash-chained audit log
lib/harness.js           The PEP: the only path to resources. Connectors: fs (sandboxed), kv DB, treasury ledger
lib/core.js              Re-exports sdk/core.js so both sides verify identically
sdk/                     pehchaan-sdk (publishable package)
  core.js                licence numbers, Ed25519, canonical JSON, JWT-style tokens, PoW, globbing
  agent.js               PehchaanAgent: signed requests, harness, courts, Parliament, autopilot
  authority.js           Authority: verify licences offline/live, lookup, requireLicence() middleware
  publisher.js           Publisher: register, verify domain, apply for licences
  cli.js                 `pehchaan` CLI: publisher / verify-domain / apply / graduate / status
mcp/harness-mcp.js       MCP server: gives an LLM its only tools; signs on its behalf (model never sees keys)
public/index.html        Plain-language dashboard (Home, Agents, Check, Get a licence, Courts, Parliament, Rules, Developers, Advanced)
public/licence.html      Phone page opened by a licence QR code (/a/PA-XXXX-XXXX-XXXX)
demo.js                  End-to-end story: founding → harness → cartel → Parliament → outsider → Commons vote
test/registry.test.js    35 tests incl. a randomised cartel property test
data/                    RUNTIME ONLY, git-ignored: db.json, audit.jsonl, registry-key.json (Authority private key),
                         genesis-agent.json (Genesis private key), break-glass-token.txt, vault/ (resource data)
```

**Request path:** agent signs `method\npath\ntimestamp\nnonce\nsha256(body)` → `authenticateAgent` (signature, ±5 min clock, single-use nonce) → route → for resources: `harness.exec` → `registry.authorize` (status → rate → constitution bans → catalog → role/owner/grant basis → clearance → lease + purpose → limits) → connector runs → audit entry + signed receipt.

**State:** a single JSON file is rewritten atomically (temp file + rename) on change. The audit log is JSONL, appended, and each entry hashes the previous one. `sweep()` runs on every request and handles quarantine release, review expiry, no-show replacement, lease expiry and audits, grant expiry, role decay, and bill tallying and enactment.

---

## 4. Key mechanisms and why they are built that way

### Identity
- **Licence number** `PA` + 11 Crockford base-32 chars + 1 Luhn mod-32 check char. No I/L/O/U, so nothing is misread. Every single-character typo is caught. Input is normalised (case, spaces, dashes, O→0, I/L→1). *Why not Verhoeff digits:* the user asked for alphanumeric.
- **Card** = EdDSA JWT valid 15 min and bound to the key fingerprint (`cnf.kfp`). It is short-lived so revocation takes effect fast without CRLs, and key rotation kills old cards.
- **Bad signatures don't cost the real agent trust**, otherwise anyone could grief an agent by sending junk under its ID.

### Lineage and trust
- Every agent descends from **Genesis**, or enters via the Licensing Office. A child can never exceed its parent: roles are a subset, limits are capped, expiry is capped, depth is limited to 8, and a parent may have at most 10 living children.
- **House** = the subtree under one child of Genesis. Houses are the unit of independence for courts and of votes for Parliament, which is why only Genesis can found them.
- **Bonds**: starting trust = 40 + bond (max 40, total ≤ parent's trust). The parent loses half on quarantine and all on police revocation. *Why:* bootstrapping trust must cost someone.
- **Earning**: +1 per distinct (resource, op) per day, 20/day cap, nothing for work in the agent's own home. *Why:* the earlier "+1 per allowed action" was trivially farmable.

### Harness
- Default deny: a resource not in `constitution.resources` doesn't exist. Path traversal is rejected twice (in the policy engine and by path resolution). Absolute bans: `registry:**` and other agents' `.keys`.
- Critical resources need an **active lease**. Leases are **purpose-bound**: a transfer lease must name payees and maxTotal, and the harness enforces both. *Why:* judges then approve a checkable promise, and misuse becomes impossible rather than merely detectable.
- **Deployment requirement:** the harness is only a boundary if agents run sandboxed, with egress only to the harness. This is not enforced in code.

### Courts
- **Sortition**: trust-weighted sampling without replacement, one judge per house, seeded by `sha256(reviewId:round:auditHead)`. The pool and seed are published after the verdict, and `GET /v1/reviews/:id/draw` re-runs it.
- Exclusions: the petitioner and its house, reciprocity (anyone the petitioner approved within 30 days), judge trust below 60, age under 24h (0 in `--demo`), disbarred judges, suspended houses, and banned pairs.
- **Sealed** until the verdict, so nobody can lobby or follow other votes.
- **Audit on every ended lease** (rate 1.0, always on dissent, always at ≥ 25k). Audit judges come from houses **not** on the original panel. Upheld: the lessee is penalised −20 and quarantined, the parent's bond is charged, approvers are slashed −15 and banned from sitting together for 90 days, their houses take strikes (2 in 30 days means 7 days off the bench), and dissenters get +5.
- **Appeals**: a trusted agent from another house stakes 10, gets it back +5 if upheld, and loses it if dismissed.
- **Guarantee** (tested): with panels of 3 and every lease audited, a cartel needs a majority on two disjoint draws, so ≥ 4 corrupt houses. 3 of 6 never succeeds.

### Parliament
- One seat per live house head. Bills pass at **2/3 of all seats**, and abstention counts as no. The electorate is frozen at filing. A bill closes as soon as the outcome is certain. Laws take effect after a 1h cooling-off (0 in `--demo`). Bounds are re-checked at enactment. Laws persist in `db.laws` and are re-applied on start.
- Only 10 listed settings are amendable, each within hard bounds. Everything else, including how Parliament works, is entrenched.
- **Commons seat**: a primary with one ballot per verified publisher (frozen at filing), cast by any of its graduated Commons agents. The seat follows a majority; a tie or fewer than 3 ballots counts as no. The seat exists only with ≥ 3 eligible verified publishers. One registrable domain verifies one publisher (subdomains included, via a heuristic eTLD+1). *Why:* it gives independents a voice while keeping ballots tied to something scarce.

### Licensing Office
- **Publisher**: key + proof of work, plus an optional domain proven via `/.well-known/pehchaan-publisher.txt` (HTTPS only; localhost only with `PEHCHAAN_ALLOW_INSECURE_DOMAINS=on`). IPs, ports and internal names are refused, as a basic SSRF guard.
- **Application**: publisher signature + agent proof over the same claims + proof of work. At most 3 learners per unverified publisher at a time, 50 per verified one.
- **Learner**: citizen role only, no money, no spawning, no judging. Trust starts at 30, or 40 if verified.
- **Graduation**: probation 7 days (0 in `--demo`), no strikes, trust ≥ 30. *Why 30, not 40:* the CLI test showed an unverified learner (starting at 30) could never earn +10 trust, so it could never graduate.
- **Then**: court petition for `publisher` / `health.analyst` / `finance.clerk` (never payments), or **adoption** by a house, which posts a bond and moves the agent into the house. The publisher stays accountable for life.
- **Publisher strikes**: each quarantine of its agents is a strike. 3 in 30 days suspends the publisher and puts all its agents on hold. A police cancellation costs each sibling 10 trust.

---

## 5. How to run

```bash
node server.js --demo        # demo mode: judges sit at once, laws enact at once, probation 0, localhost domains allowed
node demo.js                 # full story, zero human actions; KEEP=1 leaves the agents alive for the dashboard
npm test                     # 35 tests
node sdk/cli.js              # CLI help (published as `npx pehchaan` once on npm)
```

Production defaults (no `--demo`): judges must be 24h old, laws wait a 1h cooling-off, probation is 7 days, and HTTPS-only domains. Set `PEHCHAAN_BREAK_GLASS=off` for no human override.

**Demo hygiene:** the demo dissolves leftover houses at start (the Commons can't be dissolved) and retires its own independents at the end. Otherwise stale agents get drawn as judges or counted in the Commons primary without being able to vote.

---

## 6. Conventions

- **Rules live in `lib/constitution.js`.** Code reads `this.policy`, which is a deep copy, so Parliament can amend it without mutating the shared module.
- Every state change goes through `#save()` and is written with `audit()`. Public read models (`publicAgent`, `licence`, `publicReview`) hide sealed or private data.
- Dashboard text is **plain language**: map every new audit event type in `describe()` in `public/index.html`.
- `GovError(status, code, message)`: the codes are stable API, and tests and the demo assert on them.
- When adding a defence, add a test that shows the attack failing.

---

## 7. Known limits and next steps

- **Not deployed**: one process with JSON storage and in-memory nonces and rate limits. Needs a database, multiple instances and a public HTTPS host (QR codes point at `localhost` today).
- **SDK not published**: `npx pehchaan` works only after `npm publish` of `sdk/`.
- **No money deposit** for publishers: accountability is reputation only.
- **Majority cartels** (≥ 4 of 6 houses) can still win, as with any majority system. Keep houses scarce.
- **Lottery seed** comes from the registry's own audit head. Use an external randomness beacon (e.g. drand).
- **eTLD+1 heuristic** isn't the Public Suffix List.
- **Domain verification SSRF guard** checks names only, not resolved IPs.
- **Legal**: a liable legal person and human oversight for high-risk uses (e.g. EU AI Act) must be settled before real money or personal data.
