#!/usr/bin/env node
// End-to-end test for the MITRE ATT&CK catalog, TTP enrichment and TheHive 5
// procedure compatibility. It serves its own small STIX 2.x fixture, imports it
// through the API, and removes every object it created before exiting.
//
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/mitre-test.mjs
//   MITRE_REAL=1 node scripts/mitre-test.mjs   # also imports the real catalog
//
// MYHIVE_URL may include /api/v1; both forms are accepted.

import http from 'node:http';

const ORIGIN = (process.env.MYHIVE_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const V1 = `${ORIGIN}/api/v1`;
const LOGIN = process.env.MYHIVE_LOGIN || 'admin@myhive.local';
const PASSWORD = process.env.MYHIVE_PASSWORD || 'admin123';
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let token = '';
let passed = 0;
let failed = 0;
const cleanup = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, url, body) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method, headers, body: payload });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, ok: response.ok, data, text };
}

async function call(method, url, body) {
  const result = await request(method, url, body);
  if (!result.ok) throw new Error(`${method} ${url} → ${result.status}: ${result.text.slice(0, 400)}`);
  return result.data;
}

async function test(name, fn) {
  try {
    const note = await fn();
    passed++;
    console.log(`PASS ${name}${note ? ` (${note})` : ''}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await call('GET', `${V1}/patterns/import/${jobId}`);
    if (job.status === 'Success' || job.status === 'Failure') return job;
    if (Date.now() > deadline) throw new Error(`import job ${jobId} did not finish (last status ${job.status})`);
    await sleep(200);
  }
}

function externalReference(externalId) {
  return [{
    source_name: 'mitre-attack',
    external_id: externalId,
    url: `https://attack.mitre.org/techniques/${externalId.replace(/\./g, '/')}/`,
  }];
}

function tactic(stixId, tacticId, name, shortName) {
  return {
    type: 'x-mitre-tactic',
    id: stixId,
    name,
    x_mitre_shortname: shortName,
    description: `${name} tactic from the fixture`,
    external_references: externalReference(tacticId),
  };
}

function technique(options) {
  return {
    type: 'attack-pattern',
    id: `attack-pattern--${options.id}`,
    name: options.name,
    description: options.description || `Fixture description for ${options.name}`,
    external_references: externalReference(options.id),
    kill_chain_phases: (options.tactics || []).map((phase) => ({ kill_chain_name: 'mitre-attack', phase_name: phase })),
    x_mitre_platforms: ['Linux', 'Windows'],
    x_mitre_is_subtechnique: !!options.subtechnique,
    x_mitre_version: '1.0',
    x_mitre_data_sources: ['Network Traffic'],
    x_mitre_detection: `Detection guidance for ${options.name}`,
    revoked: !!options.revoked,
    x_mitre_deprecated: !!options.deprecated,
  };
}

const tacticRecon = tactic('x-mitre-tactic--fixture-recon', 'TA9990', 'Reconnaissance', 'fixture-reconnaissance');
const tacticDiscovery = tactic('x-mitre-tactic--fixture-discovery', 'TA9991', 'Discovery', 'fixture-discovery');

const fixture = {
  type: 'bundle',
  id: 'bundle--fixture',
  spec_version: '2.1',
  objects: [
    tacticRecon,
    tacticDiscovery,
    {
      type: 'x-mitre-matrix',
      id: 'x-mitre-matrix--fixture',
      name: 'Enterprise ATT&CK fixture',
      tactic_refs: [tacticRecon.id, tacticDiscovery.id],
    },
    technique({ id: 'T9990', name: 'Fixture Scanner', tactics: ['fixture-reconnaissance'] }),
    technique({
      id: 'T9991',
      name: 'Fixture Parent Technique',
      tactics: ['fixture-discovery'],
      description: 'Parent fixture whose description mentions T9990 but whose id and name do not.',
    }),
    technique({ id: 'T9991.001', name: 'Fixture Sub Technique', tactics: ['fixture-discovery'], subtechnique: true }),
    technique({ id: 'T9992', name: 'Fixture Revoked Technique', tactics: ['fixture-discovery'], revoked: true }),
    technique({
      id: 'T9993',
      name: 'Fixture Deprecated Technique',
      tactics: ['fixture-reconnaissance'],
      deprecated: true,
      description: 'Deprecated fixture whose description mentions T9990 and T9991.001 but whose id and name do not.',
    }),
  ],
};

console.log(`MyHive MITRE ATT&CK test → ${ORIGIN}\n`);

let fixtureServer;
let fixtureUrl;
await test('serve STIX fixture', async () => {
  fixtureServer = http.createServer((req, res) => {
    // Delay the response so the second import request races a running job.
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixture));
    }, 800);
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const { port } = fixtureServer.address();
  fixtureUrl = `http://127.0.0.1:${port}/enterprise-attack.json`;
  return fixtureUrl;
});

await test('login', async () => {
  const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD });
  token = result.token;
  assert(token, 'no token');
  return result.user?.login;
});

let firstJobId;
await test('start background import from a URL', async () => {
  const result = await call('POST', `${V1}/patterns/import`, { url: fixtureUrl });
  assert(result?.jobId, `unexpected response: ${JSON.stringify(result)}`);
  firstJobId = result.jobId;
  cleanup.push(async () => {
    for (const patternId of ['T9991.001', 'T9990', 'T9991', 'T9992', 'T9993']) {
      await call('DELETE', `${V1}/patterns/${encodeURIComponent(patternId)}`).catch(() => undefined);
    }
    for (const tacticId of ['TA9990', 'TA9991']) {
      await call('DELETE', `${V1}/tactics/${tacticId}`).catch(() => undefined);
    }
  });
  return result.jobId;
});

await test('a concurrent import is rejected with 409', async () => {
  const result = await request('POST', `${V1}/patterns/import`, { url: fixtureUrl });
  assert(result.status === 409, `expected 409, got ${result.status}: ${result.text.slice(0, 200)}`);
  return `HTTP ${result.status}`;
});

let importSummary;
await test('import job completes with the expected counts', async () => {
  const job = await waitForJob(firstJobId);
  assert(job.status === 'Success', `job failed: ${JSON.stringify(job.result)}`);
  importSummary = job.result;
  assert(importSummary.tactics === 2, `tactics=${importSummary.tactics}`);
  assert(importSummary.techniques === 4, `techniques=${importSummary.techniques}`);
  assert(importSummary.subtechniques === 1, `subtechniques=${importSummary.subtechniques}`);
  assert(importSummary.revoked === 2, `revoked=${importSummary.revoked}`);
  assert(importSummary.created === 5, `created=${importSummary.created}`);
  assert(importSummary.updated === 0, `updated=${importSummary.updated}`);
  return JSON.stringify(importSummary);
});

await test('imported techniques keep their catalog fields', async () => {
  const result = await call('GET', `${V1}/patterns?search=T9991.001&limit=50`);
  const sub = (result.items || []).find((item) => item.patternId === 'T9991.001');
  assert(sub, 'sub-technique not found');
  assert(sub.isSubtechnique === true, `isSubtechnique=${sub.isSubtechnique}`);
  assert(sub.parentPatternId === 'T9991', `parentPatternId=${sub.parentPatternId}`);
  assert(sub.name === 'Fixture Sub Technique', `name=${sub.name}`);
  assert(String(sub.url || '').includes('attack.mitre.org'), `url=${sub.url}`);
  assert(sub.version === '1.0', `version=${sub.version}`);
  assert((sub.dataSources || []).includes('Network Traffic'), `dataSources=${JSON.stringify(sub.dataSources)}`);
  assert(String(sub.detection || '').includes('Detection guidance'), `detection=${sub.detection}`);
  assert((sub.tactics || []).includes('Discovery'), `tactics=${JSON.stringify(sub.tactics)}`);
  return `${sub.patternId} → ${sub.parentPatternId}`;
});

await test('search returns parents and sub-techniques', async () => {
  const result = await call('GET', `${V1}/patterns?search=T9991&limit=50`);
  const ids = (result.items || []).map((item) => item.patternId);
  assert(ids.includes('T9991'), `missing T9991: ${JSON.stringify(ids)}`);
  assert(ids.includes('T9991.001'), `missing T9991.001: ${JSON.stringify(ids)}`);
  return ids.join(', ');
});

await test('search ranks exact ids and prefixes above description matches', async () => {
  const exact = await call('GET', `${V1}/patterns?search=T9990&limit=50`);
  const exactIds = (exact.items || []).map((item) => item.patternId);
  assert(exactIds[0] === 'T9990', `first result for T9990 is ${exactIds[0]}: ${JSON.stringify(exactIds)}`);
  const decoyIndex = exactIds.indexOf('T9991');
  assert(decoyIndex > 0, `description-only T9991 should rank after T9990: ${JSON.stringify(exactIds)}`);

  const prefix = await call('GET', `${V1}/patterns?search=T9991&limit=50`);
  const prefixIds = (prefix.items || []).map((item) => item.patternId);
  assert(prefixIds[0] === 'T9991', `first result for T9991 is ${prefixIds[0]}: ${JSON.stringify(prefixIds)}`);
  assert(prefixIds[1] === 'T9991.001', `second result for T9991 is ${prefixIds[1]}: ${JSON.stringify(prefixIds)}`);
  assert(prefixIds.indexOf('T9993') === -1 || prefixIds.indexOf('T9993') > 1, `description-only T9993 should rank after id matches: ${JSON.stringify(prefixIds)}`);

  const name = await call('GET', `${V1}/patterns?search=Fixture Sub Technique&limit=50`);
  assert((name.items || [])[0]?.patternId === 'T9991.001', `name exact match did not rank first: ${JSON.stringify((name.items || []).map((item) => item.patternId))}`);
  return `T9990 first; T9991 then T9991.001`;
});

await test('tactic filter hides revoked by default and can include them', async () => {
  const active = await call('GET', `${V1}/patterns?tactic=Discovery&limit=5000`);
  const activeIds = (active.items || []).map((item) => item.patternId);
  assert(activeIds.includes('T9991'), `missing T9991: ${JSON.stringify(activeIds)}`);
  assert(!activeIds.includes('T9992'), `revoked T9992 leaked: ${JSON.stringify(activeIds)}`);

  const hidden = await call('GET', `${V1}/patterns?search=T9992&limit=50`);
  assert((hidden.items || []).length === 0, `revoked pattern found without includeRevoked: ${JSON.stringify(hidden.items)}`);

  const all = await call('GET', `${V1}/patterns?tactic=Discovery&includeRevoked=true&limit=5000`);
  const allIds = (all.items || []).map((item) => item.patternId);
  assert(allIds.includes('T9992'), `revoked T9992 missing with includeRevoked: ${JSON.stringify(allIds)}`);
  assert(all.total >= allIds.length, `total=${all.total}`);
  return `${activeIds.length} active / ${allIds.length} total`;
});

await test('tactics endpoint follows the matrix order', async () => {
  const tactics = await call('GET', `${V1}/tactics`);
  assert(Array.isArray(tactics) && tactics.length >= 2, `tactics=${JSON.stringify(tactics).slice(0, 200)}`);
  const recon = tactics.find((item) => item.tacticId === 'TA9990');
  const discovery = tactics.find((item) => item.tacticId === 'TA9991');
  assert(recon && discovery, 'fixture tactics not found');
  assert(recon.shortName === 'fixture-reconnaissance' && recon.name === 'Reconnaissance', JSON.stringify(recon));
  assert(recon.order < discovery.order, `order: ${recon.order} >= ${discovery.order}`);
  return `${recon.tacticId}@${recon.order}, ${discovery.tacticId}@${discovery.order}`;
});

let caseItem;
await test('create a case for the procedure checks', async () => {
  caseItem = await call('POST', `${V1}/cases`, { title: `mitre test ${stamp}`, description: 'MITRE catalog test' });
  cleanup.push(() => call('DELETE', `${V1}/cases/${caseItem.id}?force=true`).catch(() => undefined));
  assert(caseItem.id, JSON.stringify(caseItem).slice(0, 200));
  return caseItem.id;
});

await test('procedure with only patternId gets name and single tactic', async () => {
  const procedure = await call('POST', `${V1}/cases/${caseItem.id}/procedures`, { patternId: 'T9991.001' });
  assert(procedure.patternName === 'Fixture Sub Technique', `patternName=${procedure.patternName}`);
  assert(procedure.tactic === 'Discovery', `tactic=${procedure.tactic}`);
  return `${procedure.patternName} · ${procedure.tactic}`;
});

let compatProcedure;
await test('TheHive 5 POST /case/:id/procedure returns a mapped Procedure', async () => {
  compatProcedure = await call('POST', `${V1}/case/${caseItem.id}/procedure`, {
    patternId: 'T9990',
    occurDate: Date.now(),
    description: 'Compat procedure',
  });
  assert(compatProcedure._id && compatProcedure._type === 'Procedure', JSON.stringify(compatProcedure).slice(0, 250));
  assert(compatProcedure.patternName === 'Fixture Scanner', `patternName=${compatProcedure.patternName}`);
  assert(compatProcedure.tactic === 'Reconnaissance', `tactic=${compatProcedure.tactic}`);
  assert(String(compatProcedure.url || '').includes('attack.mitre.org'), `url=${compatProcedure.url}`);
  assert(compatProcedure.extraData?.pattern?.patternId === 'T9990', JSON.stringify(compatProcedure.extraData));
  assert((compatProcedure.extraData?.pattern?.tactics || []).includes('Reconnaissance'), JSON.stringify(compatProcedure.extraData));
  return compatProcedure._id;
});

await test('TheHive 5 PATCH /procedure/:id updates it', async () => {
  const updated = await call('PATCH', `${V1}/procedure/${compatProcedure._id}`, { description: 'Updated compat procedure' });
  assert(updated._type === 'Procedure', JSON.stringify(updated).slice(0, 200));
  assert(updated.description === 'Updated compat procedure', `description=${updated.description}`);
  assert(updated.patternName === 'Fixture Scanner', `patternName=${updated.patternName}`);
  return updated._id;
});

await test('TheHive 5 POST /alert/:id/procedure works too', async () => {
  const alert = await call('POST', `${V1}/alerts`, {
    title: `mitre alert ${stamp}`,
    type: 'mitre-test',
    source: 'mitre-test',
    sourceRef: `mitre-${stamp}`,
    description: 'alert procedure test',
    procedures: [],
  });
  cleanup.push(() => call('DELETE', `${V1}/alerts/${alert.id}`).catch(() => undefined));
  const procedure = await call('POST', `${V1}/alert/${alert.id}/procedure`, { patternId: 'T9991', occurDate: Date.now() });
  assert(procedure._type === 'Procedure', JSON.stringify(procedure).slice(0, 200));
  assert(procedure.patternName === 'Fixture Parent Technique', `patternName=${procedure.patternName}`);
  assert(procedure.tactic === 'Discovery', `tactic=${procedure.tactic}`);
  return procedure._id;
});

await test('compat case includes mapped procedures', async () => {
  const result = await call('GET', `${V1}/case/${caseItem.id}`);
  const found = (result.procedures || []).find((item) => item._id === compatProcedure._id);
  assert(found, 'procedure missing from compat case');
  assert(found.extraData?.pattern?.patternId === 'T9990', JSON.stringify(found.extraData));
  assert(found._type === 'Procedure', `_type=${found._type}`);
  return `${(result.procedures || []).length} procedure(s)`;
});

await test('TheHive 5 DELETE /procedure/:id removes a procedure', async () => {
  const created = await call('POST', `${V1}/case/${caseItem.id}/procedure`, { patternId: 'T9991.001', occurDate: Date.now() });
  await call('DELETE', `${V1}/procedure/${created._id}`);
  const result = await call('GET', `${V1}/case/${caseItem.id}`);
  assert(!(result.procedures || []).some((item) => item._id === created._id), 'deleted procedure still present');
  return created._id;
});

await test('Query listPattern returns TheHive-shaped patterns', async () => {
  const result = await call('POST', `${V1}/query`, {
    query: [
      { _name: 'listPattern' },
      { _name: 'filter', _and: [{ _eq: { _field: 'patternId', _value: 'T9990' } }] },
    ],
  });
  assert(Array.isArray(result) && result.length === 1, JSON.stringify(result).slice(0, 300));
  const pattern = result[0];
  assert(pattern._type === 'Pattern', `_type=${pattern._type}`);
  assert(pattern._id, 'missing _id');
  assert(pattern.patternId === 'T9990', `patternId=${pattern.patternId}`);
  assert(pattern.name === 'Fixture Scanner', `name=${pattern.name}`);
  assert(Array.isArray(pattern.tactics), `tactics=${JSON.stringify(pattern.tactics)}`);
  assert(String(pattern.url || '').includes('attack.mitre.org'), `url=${pattern.url}`);
  assert(pattern.revoked === false, `revoked=${pattern.revoked}`);
  assert(pattern.isSubtechnique === false, `isSubtechnique=${pattern.isSubtechnique}`);
  return `${pattern.patternId} · ${pattern.name}`;
});

await test('procedures stats counts distinct cases per technique', async () => {
  const second = await call('POST', `${V1}/cases`, { title: `mitre stats ${stamp}`, description: 'stats test' });
  cleanup.push(() => call('DELETE', `${V1}/cases/${second.id}?force=true`).catch(() => undefined));
  await call('POST', `${V1}/cases/${second.id}/procedures`, { patternId: 'T9990' });
  const stats = await call('GET', `${V1}/procedures/stats?days=90`);
  const scanner = (stats.items || []).find((item) => item.patternId === 'T9990');
  assert(scanner, `T9990 missing from stats: ${JSON.stringify(stats).slice(0, 300)}`);
  assert(scanner.caseCount === 2, `T9990 caseCount=${scanner.caseCount}`);
  assert((stats.items || []).length <= 10, `too many items: ${stats.items.length}`);
  return `${scanner.patternId} in ${scanner.caseCount} cases`;
});

await test('re-import is idempotent (updates, does not duplicate)', async () => {
  const started = await call('POST', `${V1}/patterns/import`, { url: fixtureUrl });
  const job = await waitForJob(started.jobId);
  assert(job.status === 'Success', `job failed: ${JSON.stringify(job.result)}`);
  assert(job.result.created === 0, `created=${job.result.created}`);
  assert(job.result.updated === 5, `updated=${job.result.updated}`);
  const result = await call('GET', `${V1}/patterns?search=T9991&limit=100`);
  const parentCount = (result.items || []).filter((item) => item.patternId === 'T9991').length;
  assert(parentCount === 1, `T9991 duplicated: ${parentCount}`);
  return `created=${job.result.created}, updated=${job.result.updated}`;
});

await test('cleanup fixture patterns and tactics', async () => {
  for (const patternId of ['T9991.001', 'T9990', 'T9991', 'T9992', 'T9993']) {
    await call('DELETE', `${V1}/patterns/${encodeURIComponent(patternId)}`).catch(() => undefined);
  }
  for (const tacticId of ['TA9990', 'TA9991']) {
    await call('DELETE', `${V1}/tactics/${tacticId}`).catch(() => undefined);
  }
  const remaining = await call('GET', `${V1}/patterns?search=T999&includeRevoked=true&limit=50`);
  assert((remaining.items || []).length === 0, `fixture patterns left behind: ${JSON.stringify(remaining.items)}`);
  return 'fixture removed';
});

await test('real 50 MB import (only with MITRE_REAL=1)', async () => {
  if (process.env.MITRE_REAL !== '1') return 'SKIP: set MITRE_REAL=1 to run it';
  const started = await call('POST', `${V1}/patterns/import`, {});
  const job = await waitForJob(started.jobId, 300000);
  assert(job.status === 'Success', `job failed: ${JSON.stringify(job.result)}`);
  assert(job.result.techniques > 100, `techniques=${job.result.techniques}`);
  return `${job.result.tactics} tactics · ${job.result.techniques}+${job.result.subtechniques} techniques`;
});

for (const fn of cleanup.reverse()) await fn();
if (fixtureServer) fixtureServer.close();

console.log(`\n${passed} PASS · ${failed} FAIL`);
process.exit(failed ? 1 : 0);
