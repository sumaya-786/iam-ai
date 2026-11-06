// The constitution of the agent state. Every rule the system enforces on itself lives here
// and is published at GET /v1/registry/policy. No human edits it at runtime.
'use strict';
const env = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);

module.exports = {
  // ---------- Citizenship & birth ----------
  // Agents are born of agents. Outsiders enter only through the Licensing Office (below), never as a new house.
  clockSkewMs: 5 * 60 * 1000,
  cardTtlS: 15 * 60,
  lifetimeDays: 30,
  maxDepth: 8,
  maxChildren: 10,

  // ---------- Trust (reputation) ----------
  trust: {
    initial: 40, genesis: 100, max: 100,
    deny: -3, reviewRejected: -5, childQuarantined: -5,
    renewMin: 30, spawnMin: 30,
    // Anti-farming: work in your own home earns nothing; each (resource, op) earns at most once a day; daily cap.
    dailyEarnCap: Number(env('PEHCHAAN_DAILY_EARN_CAP', 20)),
    // Bootstrapping is a bond, not a gift: a parent backs a child with trust it can lose.
    maxEndowment: 40,
  },

  // ---------- Police ----------
  quarantine: {
    below: 20, burstDenials: 5, burstWindowMs: 60_000,
    seconds: Number(env('PEHCHAAN_QUARANTINE_SECONDS', 600)),
    releaseTrust: 30, strikesToRevoke: 3,
  },

  // ---------- Treasury ----------
  newbornCaps: { maxTxnAmount: 10_000, dailySpend: 50_000, ratePerMinute: 120 },

  // ---------- Clearance: trust needed per classification ----------
  clearance: { public: 0, internal: 20, confidential: 50, critical: 70 },

  // ---------- Resource catalog (default deny: anything not listed does not exist) ----------
  // Patterns: `*` = one path segment, `**` = anything.
  resources: [
    { pattern: 'fs:public/**', type: 'fs', classification: 'public', description: 'Public notices' },
    { pattern: 'fs:home/**', type: 'fs', classification: 'internal', description: 'Each citizen\'s private home directory' },
    { pattern: 'fs:finance/**', type: 'fs', classification: 'confidential', description: 'Finance ministry files' },
    { pattern: 'fs:health/**', type: 'fs', classification: 'confidential', description: 'Health ministry files' },
    { pattern: 'db:customers', type: 'kv', classification: 'critical', description: 'Customer database' },
    { pattern: 'ledger:treasury', type: 'ledger', classification: 'critical', description: 'State treasury (payments)' },
  ],

  // ---------- Ministries (roles) ----------
  roles: {
    'citizen':        { ministry: 'Home', title: 'Read public notices', permissions: [{ resource: 'fs:public/**', ops: ['read', 'list'] }] },
    'finance.clerk':  { ministry: 'Finance', title: 'Read and prepare finance documents', permissions: [{ resource: 'fs:finance/**', ops: ['read', 'list', 'write'] }, { resource: 'ledger:treasury', ops: ['read'] }] },
    'finance.payer':  { ministry: 'Finance', title: 'Make payments (only with a court’s permission)', permissions: [{ resource: 'ledger:treasury', ops: ['read', 'transfer'] }] },
    'health.analyst': { ministry: 'Health', title: 'Read health reports', permissions: [{ resource: 'fs:health/**', ops: ['read', 'list'] }] },
    'data.steward':   { ministry: 'Data', title: 'Look after the customer database (only with a court’s permission)', permissions: [{ resource: 'db:customers', ops: ['read', 'list', 'write'] }] },
    'auditor':        { ministry: 'Audit', title: 'Inspect finance records', permissions: [{ resource: 'fs:finance/**', ops: ['read', 'list'] }, { resource: 'ledger:treasury', ops: ['read'] }] },
    'publisher':      { ministry: 'Information', title: 'Publish public notices', permissions: [{ resource: 'fs:public/**', ops: ['read', 'list', 'write'] }] },
  },
  // Separation of duties: no agent may hold both roles of a pair.
  conflicts: [['finance.payer', 'auditor'], ['data.steward', 'auditor']],
  defaultRoles: ['citizen'],                   // every agent is born a citizen
  roleDecayDays: Number(env('PEHCHAAN_ROLE_DECAY_DAYS', 30)), // unused roles are stripped automatically

  // ---------- Courts: just-in-time privileged access, built to resist collusion ----------
  // Critical resources need a court-approved, time-boxed, PURPOSE-BOUND lease: a transfer lease must name its
  // payees and a maximum total, and the harness refuses anything outside them.
  leases: { maxSeconds: 3600, maxPayees: 10 },
  courts: {
    panelSize: 3, appealPanelSize: 3,          // majority decides
    judgeMinTrust: 60,
    judgeMinAgeSeconds: Number(env('PEHCHAAN_JUDGE_MIN_AGE_SECONDS', 86400)), // no instant sock-puppet judges
    judgeDeadlineMs: Number(env('PEHCHAAN_JUDGE_DEADLINE_MS', 5 * 60 * 1000)), // no-shows are replaced and penalised
    noShowPenalty: -2,
    reviewTtlMs: 30 * 60 * 1000,
    reciprocityDays: 30,                       // if A approved B's petition, B may not judge A
    serviceReward: 1,                          // per ruling (counts toward the daily cap)
    slash: -15, objectorReward: 5,             // approvers of an overturned lease are slashed; dissenters rewarded
    disbarAfterOverturned: 2,
    appeal: { windowDays: 7, stake: 10, reward: 5, challengerMinTrust: 50, misusePenalty: -20 },
    // ----- Against cross-house cartels -----
    // Every ended lease may be audited by a fresh panel drawn from houses that did NOT sit on the original case.
    // Default 1.0: every lease is audited. At lower rates a cartel that captures ALL seats of a panel (so no one
    // dissents) escapes with probability (1 - rate). With every lease audited, a cartel must hold a majority on two
    // panels drawn from disjoint houses, which needs at least 4 corrupt houses.
    audit: {
      rate: Number(env('PEHCHAAN_AUDIT_RATE', 1)),   // verifiable lottery; lower it only to save judge time
      alwaysIfDissent: true,                          // a cartel holding 2 of 3 seats is always audited
      alwaysAboveTotal: 25_000,
    },
    largePanel: { threshold: 50_000, size: 5 },       // capture gets harder as stakes rise
    coOverturnBanDays: 90,                            // judges overturned together never sit together again
    houseBench: { windowDays: 30, suspendAfter: 2, suspendDays: 7 }, // a house whose judges keep getting overturned loses the bench
  },
  grants: { maxSeconds: 7 * 86400 },           // owners may lend access to their home dir

  // ---------- Licensing Office: how an agent built by anyone gets a licence ----------
  // 1. Its developer registers as a PUBLISHER (a key, optionally a proven web domain). All of a publisher's agents share
  //    one reputation. 2. The agent APPLIES, signed by the publisher, with proof of key and a proof-of-work stamp.
  // 3. It gets a LEARNER licence in the COMMONS: one shared house for all independents, with no Parliament seat and at
  //    most one judge per panel, so mass sign-ups capture nothing. 4. After probation it GRADUATES, then can PETITION a
  //    court for a role, or be ADOPTED by a ministry that posts a bond for it.
  licensing: {
    open: env('PEHCHAAN_LICENSING', 'on') !== 'off',
    powBits: Number(env('PEHCHAAN_APPLY_POW_BITS', 16)),
    learner: { trustUnverified: 30, trustVerified: 40, days: 30, limits: { maxTxnAmount: 0, dailySpend: 0, ratePerMinute: 30 } },
    probationDays: Number(env('PEHCHAAN_PROBATION_DAYS', 7)),
    graduateMinTrust: 30,                            // = an unverified learner's starting trust: graduate with no net violations
    maxLearners: { unverified: 3, verified: 50 },        // per publisher, at any one time
    courtGrantableRoles: ['publisher', 'health.analyst', 'finance.clerk'], // never payments: that needs adoption by a ministry
    publisherStrikes: { windowDays: 30, suspendAfter: 3, suspendDays: 30, siblingPenalty: -10 },
    adoptionOfferHours: 24,
    allowInsecureDomains: env('PEHCHAAN_ALLOW_INSECURE_DOMAINS', 'off') === 'on', // dev only: http://localhost domains
  },

  // ---------- Parliament of houses ----------
  // Each house (a family founded by Genesis) casts ONE vote through its head, so spawning more agents buys no votes.
  // A bill passes only with a supermajority of ALL live houses (abstaining counts against), only changes a listed
  // rule, only within safe bounds, and only after a cooling-off delay. Everything else is entrenched.
  legislature: {
    proposerMinTrust: 70,
    passShare: 2 / 3,
    minHouses: 3,
    votingSeconds: Number(env('PEHCHAAN_BILL_SECONDS', 86400)),
    enactDelaySeconds: Number(env('PEHCHAAN_ENACT_DELAY_SECONDS', 3600)),
    maxOpenPerProposer: 3,
    // The Commons' seat: independents vote in a primary, ONE ballot per verified publisher (not per agent), and the
    // seat goes the way of a majority of those publishers. A tie, or too few ballots by the deadline, counts as no.
    commons: { minPublishers: 3, verifiedOnly: true },
    amendable: {
      'courts.audit.rate': { min: 0.5, max: 1, label: 'Share of court permissions re-checked by auditors afterwards', unit: 'share' },
      'courts.panelSize': { min: 3, max: 7, int: true, odd: true, label: 'Number of judges on a court panel', unit: 'judges' },
      'courts.judgeMinTrust': { min: 50, max: 90, int: true, label: 'Trust score needed to serve as a judge', unit: 'points' },
      'clearance.confidential': { min: 30, max: 80, int: true, label: 'Trust score needed to read confidential files', unit: 'points' },
      'clearance.critical': { min: 60, max: 95, int: true, label: 'Trust score needed to touch critical systems', unit: 'points' },
      'trust.dailyEarnCap': { min: 5, max: 50, int: true, label: 'Most trust an agent can earn in one day', unit: 'points' },
      'quarantine.burstDenials': { min: 3, max: 20, int: true, label: 'Violations in one minute that trigger an automatic suspension', unit: 'violations' },
      'quarantine.seconds': { min: 60, max: 86400, int: true, label: 'How long an automatic suspension lasts', unit: 'seconds' },
      'leases.maxSeconds': { min: 300, max: 86400, int: true, label: 'Longest a court permission can last', unit: 'seconds' },
      'lifetimeDays': { min: 7, max: 365, int: true, label: 'How long a licence lasts before it must renew', unit: 'days' },
    },
    entrenched: [
      'Every agent is born of another agent, or enters through the Licensing Office as a learner in the Commons.',
      'All access to files, databases and money goes through the harness.',
      'No one may ever touch the registry itself or another agent’s keys.',
      'No agent may both make payments and audit them.',
      'Judges are drawn by lottery, one per house, never from the house asking.',
      'Every vote, ruling and payment is published in the public record.',
      'How Parliament itself works, including the Commons seat.',
    ],
  },

  // ---------- Absolute law ----------
  forbidden: [
    { resource: 'registry:**', ops: ['*'] },
    { resource: 'fs:home/*/.keys/**', ops: ['*'] },
  ],

  breakGlass: env('PEHCHAAN_BREAK_GLASS', 'on') !== 'off',
};
