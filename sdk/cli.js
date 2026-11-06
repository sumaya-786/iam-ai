#!/usr/bin/env node
// pehchaan: get a licence for your AI agent in two commands.
//
//   pehchaan publisher --name "Ravi Labs" [--domain ravilabs.in]
//   pehchaan apply --name "Shopping Helper" --purpose "Compares prices"
//   pehchaan verify-domain          (after serving the file it tells you about)
//   pehchaan graduate agent-PA-XXXX-XXXX-XXXX.json
//   pehchaan status PA-XXXX-XXXX-XXXX
//
// Authority: --authority URL, or PEHCHAAN_AUTHORITY, or http://localhost:7420. Files are written to the current folder.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Publisher } = require('./publisher');
const { PehchaanAgent } = require('./agent');
const { Authority } = require('./authority');

const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') ? true : rest[++i]; else args.push(rest[i]); }
const AUTH = flags.authority || process.env.PEHCHAAN_AUTHORITY || 'http://localhost:7420';
const PUB_FILE = path.resolve(flags.publisher || 'publisher.json');
const say = (s = '') => console.log(s);
const fail = (s) => { console.error('✕ ' + s); process.exit(1); };

async function main() {
  switch (cmd) {
    case 'publisher': {
      if (!flags.name) fail('usage: pehchaan publisher --name "Your Name or Company" [--domain example.com]');
      if (fs.existsSync(PUB_FILE)) fail(`${path.basename(PUB_FILE)} already exists in this folder`);
      const p = Publisher.create(AUTH);
      await p.register(flags.name, { domain: flags.domain || null });
      p.save(PUB_FILE);
      say(`✓ Registered publisher "${flags.name}" (${p.id})`);
      say(`  Saved to ${path.basename(PUB_FILE)}. Keep it secret: it signs every licence application.`);
      if (flags.domain) {
        const w = p.wellKnown();
        say(`\n  To verify ${flags.domain} (raises your limits and your agents' starting trust):`);
        say(`  serve the text "${p.id}" at https://${flags.domain}${w.path}`);
        say('  then run: pehchaan verify-domain');
      }
      say('\n  Next: pehchaan apply --name "My Agent" --purpose "What it does"');
      break;
    }
    case 'verify-domain': {
      const p = Publisher.fromFile(PUB_FILE, AUTH);
      const r = await p.verifyDomain();
      say(`✓ Domain ${r.domain} verified for ${r.name}`);
      break;
    }
    case 'apply': {
      if (!flags.name) fail('usage: pehchaan apply --name "Agent name" [--purpose "..."] [--model ...] [--provider ...]');
      if (!fs.existsSync(PUB_FILE)) fail('no publisher.json here. Run: pehchaan publisher --name "Your Name"');
      const p = Publisher.fromFile(PUB_FILE, AUTH);
      say('… solving the anti-spam puzzle and applying');
      const { agent, record } = await p.applyForLicence({ name: flags.name, purpose: flags.purpose || '', model: flags.model || 'unknown', provider: flags.provider || 'unknown' });
      const file = path.resolve(`agent-${record.formattedId}.json`);
      fs.writeFileSync(file, JSON.stringify({ authority: AUTH, ...agent.toJSON() }, null, 2));
      say(`✓ Learner licence issued: ${record.formattedId}`);
      say(`  ${flags.name} · trust ${record.trust} · lives in the Commons`);
      say(`  Identity saved to ${path.basename(file)}. Keep it secret: it is the agent's key.`);
      say(`  Anyone can check it: ${new Authority(AUTH).licenceUrl(record.id)}`);
      say(`\n  Learners can read public information and use their own folder. After probation, run:`);
      say(`  pehchaan graduate ${path.basename(file)}`);
      break;
    }
    case 'graduate': {
      const file = args[0] || fail('usage: pehchaan graduate agent-PA-....json');
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const a = new PehchaanAgent({ registry: flags.authority || j.authority || AUTH, ...j });
      const r = await a.graduate();
      say(`✓ ${r.name} (${r.formattedId}) now holds a full licence.`);
      say('  Next: ask a court for a role (agent.petitionRole) or be adopted by a ministry.');
      break;
    }
    case 'status': {
      const id = args[0] || fail('usage: pehchaan status PA-XXXX-XXXX-XXXX');
      const L = await new Authority(AUTH).lookup(id);
      say(`${L.inGoodStanding ? '✓' : '✕'} ${L.name} · ${L.number}`);
      say(`  ${L.learner ? 'Learner licence' : 'Full licence'} · status ${L.status} · trust ${L.trust}`);
      if (L.publisher) say(`  Publisher: ${L.publisher.name}${L.publisher.verified ? ` (verified ${L.publisher.domain})` : ' (unverified)'}`);
      say(`  May: ${L.allowedTo.map((x) => x.title).join('; ')}`);
      break;
    }
    default:
      say('pehchaan: licences for AI agents\n');
      say('  pehchaan publisher --name "Ravi Labs" [--domain ravilabs.in]   register yourself (once)');
      say('  pehchaan verify-domain                                         prove your domain (optional)');
      say('  pehchaan apply --name "My Agent" --purpose "What it does"      get a learner licence');
      say('  pehchaan graduate agent-PA-....json                            learner → full licence');
      say('  pehchaan status PA-XXXX-XXXX-XXXX                              check any licence');
      say('\n  --authority URL   (default: PEHCHAAN_AUTHORITY or http://localhost:7420)');
  }
}
main().catch((e) => fail(e.message));
