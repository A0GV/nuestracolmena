#!/usr/bin/env node
// End-to-end test for the MyHive Functions runtime (TheHive 5 style).
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/functions-test.mjs
// MYHIVE_URL may include /api/v1; both forms are accepted.

import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryList(starter, filter) {
  const query = [{ _name: starter }];
  if (filter) query.push({ _name: 'filter', ...filter });
  return call('POST', `${V1}/query`, { query });
}

const TEMPLATES_FILE = new URL('../apps/web/src/lib/functionTemplates.ts', import.meta.url);
const templatesSource = fs.readFileSync(TEMPLATES_FILE, 'utf8');

// Extrae el valor real de la plantilla (desescapa el template literal de TypeScript).
function templateCode(key) {
  const keyAt = templatesSource.indexOf(`key: '${key}'`);
  if (keyAt < 0) throw new Error(`Template not found in functionTemplates.ts: ${key}`);
  const codeAt = templatesSource.indexOf('code: `', keyAt);
  if (codeAt < 0) throw new Error(`Template code not found in functionTemplates.ts: ${key}`);
  const start = codeAt + 'code: `'.length;
  let escaped = false;
  let end = start;
  for (; end < templatesSource.length; end++) {
    const character = templatesSource[end];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '`') break;
  }
  return vm.runInNewContext('`' + templatesSource.slice(start, end) + '`', {});
}

const WAZUH_CODE = templateCode('wazuh-alert');
const SURICATA_CODE = templateCode('suricata-eve');
const CASE_ACTION_CODE = templateCode('case-action-close-duplicates');

const HTTP_CODE = `// Llama a un servicio HTTP y devuelve su respuesta.
async function handle(input, context) {
  const response = await context.http.request({
    url: input.url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { hello: 'from-myhive' },
    timeoutMs: 5000,
  });
  return { status: response.status, body: response.body };
}`;

async function createFunction(name, code, kind = 'api', mode = 'Enabled') {
  const fn = await call('POST', `${V1}/functions`, { name, description: 'functions-test', code, kind, mode });
  cleanup.push(() => call('DELETE', `${V1}/functions/${fn.id}`).catch(() => undefined));
  return fn;
}

console.log(`MyHive Functions test → ${ORIGIN}\n`);

await test('login', async () => {
  const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD });
  token = result.token;
  assert(token, 'no token');
  return result.user?.login;
});

const wazuhName = `wazuh-alert-${stamp}`;
const wazuhRef = `wazuh-${stamp}`;
let wazuhFunction;
let wazuhAlert;

function wazuhPayload(id, description) {
  return {
    timestamp: '2026-11-03T08:12:44.120-0600',
    id,
    rule: {
      id: '100199',
      level: 12,
      description: description || 'Suricata: SID 1000099 - Escaneo SMB desde VLAN 401',
      groups: ['suricata', 'ids', 'local'],
      mitre: { id: ['T1046'], tactic: ['Discovery'] },
    },
    agent: { id: '003', name: 'kali-misp-soc', ip: '192.0.2.4' },
    manager: { name: 'wazuh-manager' },
    data: {
      src_ip: '10.40.1.23',
      dest_ip: '192.0.2.9',
      dest_port: '445',
      proto: 'TCP',
      alert: {
        signature_id: '1000099',
        signature: 'LOCAL SMB scan',
        category: 'Attempted Information Leak',
        severity: '2',
      },
      http: { hostname: 'files.example.test', url: '/x' },
      dns: { rrname: 'bad.example.test' },
    },
    full_log: '{"event_type":"alert","src_ip":"10.40.1.23","dest_ip":"192.0.2.9"}',
    location: '/var/log/suricata/eve.json',
  };
}

async function deleteAlert(id) {
  await call('DELETE', `${V1}/alert/${id}`).catch(() => undefined);
}

await test('create wazuh-alert function from the shipped template', async () => {
  wazuhFunction = await createFunction(wazuhName, WAZUH_CODE);
  assert(wazuhFunction.kind === 'api' && wazuhFunction.mode === 'Enabled', JSON.stringify(wazuhFunction));
  return wazuhFunction.id;
});

await test('Wazuh Suricata-in-Wazuh alert maps fields and observables', async () => {
  const input = wazuhPayload(wazuhRef);
  const output = await call('POST', `${V1}/function/${wazuhName}`, input);
  assert(output && output._id, `unexpected output: ${JSON.stringify(output)}`);
  assert(output.created === true, `created=${output.created}`);
  wazuhAlert = await call('GET', `${V1}/alert/${output._id}`);
  cleanup.push(() => deleteAlert(wazuhAlert._id));
  assert(wazuhAlert.type === 'wazuh', `type=${wazuhAlert.type}`);
  assert(wazuhAlert.source === 'Wazuh', `source=${wazuhAlert.source}`);
  assert(wazuhAlert.sourceRef === wazuhRef, `sourceRef=${wazuhAlert.sourceRef}`);
  assert(Number(wazuhAlert.severity) === 3, `severity=${wazuhAlert.severity}`);
  for (const tag of ['wazuh', 'rule:100199', 'sid:1000099', 'T1046']) {
    assert(wazuhAlert.tags.includes(tag), `missing tag ${tag}: ${JSON.stringify(wazuhAlert.tags)}`);
  }
  const values = (wazuhAlert.observables || []).map((item) => `${item.dataType}:${item.data}`);
  for (const expected of ['ip:10.40.1.23', 'ip:192.0.2.9', 'ip:192.0.2.4', 'fqdn:files.example.test', 'domain:bad.example.test']) {
    assert(values.includes(expected), `missing observable ${expected}: ${JSON.stringify(values)}`);
  }
  assert((wazuhAlert.procedures || []).some((item) => item.patternId === 'T1046'), `missing procedure T1046: ${JSON.stringify(wazuhAlert.procedures)}`);
  assert(String(wazuhAlert.description).includes('LOCAL SMB scan'), 'description does not include the Suricata signature');
  assert(String(wazuhAlert.description).includes('445'), 'description does not include the destination port');
  assert(String(wazuhAlert.description).includes('TCP'), 'description does not include the protocol');
  return `${wazuhAlert._id} · severity ${wazuhAlert.severity}`;
});

await test('re-posting the same Wazuh alert is idempotent', async () => {
  const output = await call('POST', `${V1}/function/${wazuhName}`, wazuhPayload(wazuhRef));
  assert(output.created === false, `expected created=false, got ${JSON.stringify(output)}`);
  assert(output._id === wazuhAlert._id, `${output._id} !== ${wazuhAlert._id}`);
  const rows = await queryList('listAlert', { _eq: { _field: 'sourceRef', _value: wazuhRef } });
  assert(rows.length === 1, `expected 1 alert with sourceRef ${wazuhRef}, got ${rows.length}`);
  return `${rows.length} alert`;
});

await test('Wazuh n8n body wrapper creates one alert', async () => {
  const ref = `${wazuhRef}-body`;
  const output = await call('POST', `${V1}/function/${wazuhName}`, { body: wazuhPayload(ref, 'Wrapped Wazuh alert') });
  assert(!Array.isArray(output), `expected one object, got ${JSON.stringify(output)}`);
  assert(output.created === true, `created=${output.created}`);
  const alert = await call('GET', `${V1}/alert/${output._id}`);
  cleanup.push(() => deleteAlert(alert._id));
  assert(Number(alert.severity) === 3 && alert.tags.includes('sid:1000099'), JSON.stringify(alert.tags));
  return alert._id;
});

await test('Wazuh array wrapper creates one alert per element', async () => {
  const firstRef = `${wazuhRef}-arr1`;
  const secondRef = `${wazuhRef}-arr2`;
  const output = await call('POST', `${V1}/function/${wazuhName}`, [
    wazuhPayload(firstRef, 'Array Wazuh alert 1'),
    wazuhPayload(secondRef, 'Array Wazuh alert 2'),
  ]);
  assert(Array.isArray(output) && output.length === 2, `expected 2 results, got ${JSON.stringify(output)}`);
  assert(output.every((item) => item.created === true), `results=${JSON.stringify(output)}`);
  for (const item of output) {
    const alert = await call('GET', `${V1}/alert/${item._id}`);
    cleanup.push(() => deleteAlert(alert._id));
    assert(Number(alert.severity) === 3, `severity=${alert.severity}`);
  }
  return `${output.length} alerts`;
});

await test('test endpoint in DryRun records alert.create and does not create an alert', async () => {
  const dryRef = `${wazuhRef}-dry`;
  const result = await call('POST', `${V1}/functions/${wazuhFunction.id}/test`, {
    input: wazuhPayload(dryRef, 'Dry run alert'),
    dryRun: true,
  });
  assert(Array.isArray(result.calls) && result.calls.some((item) => item.call === 'alert.create'), `calls=${JSON.stringify(result.calls)}`);
  assert(result.dryRun === true, 'result is not marked dryRun');
  const rows = await queryList('listAlert', { _eq: { _field: 'sourceRef', _value: dryRef } });
  assert(rows.length === 0, `dry run created ${rows.length} alert(s)`);
  return `${result.calls.length} recorded call(s)`;
});

const suricataName = `suricata-eve-${stamp}`;
let suricataFunction;

function evePayload(flowId, severity, signatureId, signature) {
  return {
    timestamp: '2026-11-03T08:12:44.120000-0600',
    flow_id: flowId,
    event_type: 'alert',
    src_ip: '10.40.1.23',
    src_port: 49712,
    dest_ip: '192.0.2.9',
    dest_port: 445,
    proto: 'TCP',
    alert: {
      action: 'allowed',
      gid: 1,
      signature_id: signatureId,
      rev: 1,
      signature,
      category: 'Attempted Information Leak',
      severity,
    },
    http: { hostname: 'files.example.test', url: '/x', http_method: 'GET' },
    dns: { rrname: 'bad.example.test' },
    tls: { sni: 'tls.example.test' },
  };
}

await test('create suricata-eve function from the shipped template', async () => {
  suricataFunction = await createFunction(suricataName, SURICATA_CODE);
  return suricataFunction.id;
});

await test('Suricata EVE alert maps severity 1→3, 2→2, 3→1 and HTTP/DNS/TLS', async () => {
  const cases = [
    { flow: `${stamp}-eve-1`, severity: 1, signatureId: 2100498, expected: 3 },
    { flow: `${stamp}-eve-2`, severity: 2, signatureId: 2100499, expected: 2 },
    { flow: `${stamp}-eve-3`, severity: 3, signatureId: 2100500, expected: 1 },
  ];
  for (const item of cases) {
    const output = await call('POST', `${V1}/function/${suricataName}`, evePayload(item.flow, item.severity, item.signatureId, `EVE severity ${item.severity}`));
    assert(output.created === true, `created=${JSON.stringify(output)}`);
    const alert = await call('GET', `${V1}/alert/${output._id}`);
    cleanup.push(() => deleteAlert(alert._id));
    assert(Number(alert.severity) === item.expected, `severity ${item.severity} mapped to ${alert.severity}, expected ${item.expected}`);
    assert(alert.type === 'suricata' && alert.source === 'Suricata', `${alert.type}/${alert.source}`);
    assert(alert.tags.includes(`sid:${item.signatureId}`), JSON.stringify(alert.tags));
    const values = (alert.observables || []).map((o) => `${o.dataType}:${o.data}`);
    for (const expected of ['ip:10.40.1.23', 'ip:192.0.2.9', 'hostname:files.example.test', 'domain:bad.example.test', 'domain:tls.example.test']) {
      assert(values.includes(expected), `missing ${expected}: ${JSON.stringify(values)}`);
    }
    if (item.severity === 1) {
      const second = await call('POST', `${V1}/function/${suricataName}`, evePayload(item.flow, item.severity, item.signatureId, `EVE severity ${item.severity}`));
      assert(second.created === false && second._id === output._id, `not idempotent: ${JSON.stringify(second)}`);
    }
  }
  return 'severities 3/2/1 · idempotent';
});

await test('a function that throws returns 400 with error and logs', async () => {
  const name = `throw-${stamp}`;
  const fn = await createFunction(
    name,
    "function handle(input, context) { context.log('log antes de fallar'); throw new Error('boom intencionado'); }",
  );
  const response = await request('POST', `${V1}/function/${name}`, {});
  assert(response.status === 400, `status=${response.status}: ${response.text}`);
  assert(String(response.data?.error || '').includes('boom intencionado'), `body=${response.text}`);
  assert(Array.isArray(response.data?.logs) && response.data.logs.some((line) => String(line).includes('log antes de fallar')), `logs=${response.text}`);
  return `status 400 · ${fn.id}`;
});

await test('an infinite loop times out without blocking other requests', async () => {
  const name = `loop-${stamp}`;
  await createFunction(name, 'function handle(input, context) { while (true) {} }');
  const pending = request('POST', `${V1}/function/${name}`, {});
  await sleep(750);
  const health = await call('GET', `${V1}/user/current`);
  assert(health && health.login, 'the API did not answer while the function was running');
  const response = await pending;
  assert([400, 504].includes(response.status), `status=${response.status}: ${response.text.slice(0, 200)}`);
  return `API answered during the loop; final status ${response.status}`;
});

await test('a Disabled function returns 409', async () => {
  const name = `disabled-${stamp}`;
  const fn = await createFunction(name, 'function handle(input, context) { return { ok: true }; }', 'api', 'Disabled');
  const response = await request('POST', `${V1}/function/${name}`, {});
  assert(response.status === 409, `status=${response.status}: ${response.text}`);
  return fn.id;
});

await test('creating a function with a syntax error returns 400', async () => {
  const response = await request('POST', `${V1}/functions`, {
    name: `bad-syntax-${stamp}`,
    code: 'function handle( {',
    kind: 'api',
    mode: 'Enabled',
  });
  assert(response.status === 400, `status=${response.status}: ${response.text}`);
  assert(/syntax|unexpected|token/i.test(String(response.data?.message || '')), `body=${response.text}`);
  return 'rejected';
});

await test('runs list returns the recent function executions', async () => {
  const rows = await call('GET', `${V1}/functions/${wazuhFunction.id}/runs?limit=10`);
  assert(Array.isArray(rows) && rows.length >= 2, `runs=${rows?.length}`);
  assert(rows.every((row) => row.type === 'function'), 'unexpected job types');
  assert(rows.some((row) => row.payload?.functionId === wazuhFunction.id), 'missing functionId in payload');
  return `${rows.length} run(s)`;
});

let duplicateFunction;
const duplicateCaseTitle = `duplicate-case-${stamp}`;
let caseA;
let caseB;

await test('an action:case function lists cases sharing observables and comments', async () => {
  const caseObservable = `203.0.113.${(Date.now() % 200) + 20}`;
  caseA = await call('POST', `${V1}/case`, {
    title: `Caso A ${stamp}`,
    description: 'Caso principal',
    severity: 2,
    observables: [{ dataType: 'ip', data: caseObservable }],
  });
  caseB = await call('POST', `${V1}/case`, {
    title: `Caso B ${stamp}`,
    description: 'Caso duplicado',
    severity: 2,
    observables: [{ dataType: 'ip', data: caseObservable }],
  });
  cleanup.push(() => call('DELETE', `${V1}/case/${caseA._id}`).catch(() => undefined));
  cleanup.push(() => call('DELETE', `${V1}/case/${caseB._id}`).catch(() => undefined));
  duplicateFunction = await createFunction(`dup-${stamp}`, CASE_ACTION_CODE, 'action:case');
  const actions = await call('GET', `${V1}/functions/actions?target=case`);
  assert(actions.some((item) => item.id === duplicateFunction.id), 'action not listed by /functions/actions');
  const result = await call('POST', `${V1}/cases/${caseA._id}/functions/${duplicateFunction.id}`);
  assert(Array.isArray(result.output?.duplicates), `output=${JSON.stringify(result.output)}`);
  assert(result.output.duplicates.some((item) => item._id === caseB._id), `duplicates=${JSON.stringify(result.output.duplicates)}`);
  const refreshed = await call('GET', `${V1}/case/${caseA._id}`);
  assert((refreshed.comments || []).some((comment) => String(comment.message).includes(`#${caseB.number}`)), 'comment was not added');
  return `${duplicateCaseTitle}: ${result.output.duplicates.length} duplicate(s)`;
});

await test('context.http.request talks to a local HTTP server', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method, received: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const name = `http-${stamp}`;
    await createFunction(name, HTTP_CODE);
    const output = await call('POST', `${V1}/function/${name}`, { url: `http://127.0.0.1:${port}/hook` });
    assert(output.status === 200, `status=${output.status}`);
    assert(output.body?.ok === true, `body=${JSON.stringify(output.body)}`);
    assert(output.body?.received?.hello === 'from-myhive', `received=${JSON.stringify(output.body?.received)}`);
    return `HTTP 200 from 127.0.0.1:${port}`;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('cleanup', async () => {
  for (const item of cleanup.reverse()) {
    await item();
  }
  return `${cleanup.length} resources removed`;
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
