// pehchaan-sdk: licences for AI agents, issued by the Pehchaan Authority.
//
//   const { PehchaanAgent, Authority, licence } = require('pehchaan-sdk');
//
// For developers:      Publisher: register once, then get learner licences for your agents (or use the `pehchaan` CLI).
// For agent builders:  PehchaanAgent: hold a licence, act through the harness, petition courts, vote in Parliament.
// For businesses:      Authority: verify any agent's licence (offline or live), or gate your API with requireLicence().
// For everyone:        licence: parse, validate and format licence numbers (PA-XXXX-XXXX-XXXX).
'use strict';
const C = require('./core');
const { PehchaanAgent } = require('./agent');
const { Authority, DEFAULT_AUTHORITY } = require('./authority');
const { Publisher } = require('./publisher');

module.exports = {
  PehchaanAgent,
  Publisher,
  Authority,
  DEFAULT_AUTHORITY,
  licence: {
    isValid: C.isValidAgentId,
    format: C.formatAgentId,
    normalize: C.normalizeAgentId,
    prefix: C.ID_PREFIX,
  },
  crypto: { generateKeyPair: C.generateKeyPair, verifyToken: C.verifyToken, decodeToken: C.decodeToken },
};
