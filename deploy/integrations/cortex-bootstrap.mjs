// Idempotent Cortex bootstrap for MyHive.
// Needs env: CORTEX_ADMIN_PASSWORD. Writes the MyHive API key to cortex/.myhive-key
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const BASE = process.env.CORTEX_LOCAL_URL || 'http://127.0.0.1:9001';
const ADMIN = 'admin';
const ADMIN_PASSWORD = process.env.CORTEX_ADMIN_PASSWORD;
const ORG = 'MyHive';
const API_USER = 'myhive';
const KEY_FILE = new URL('./cortex/.myhive-key', import.meta.url);

// Analyzers that work without any third-party API key.
const FREE_ANALYZERS = [
  'Abuse_Finder', 'DShield_lookup', 'TorProject', 'FileInfo', 'Crtsh_Transparency_Logs',
  'GoogleDNS_resolve', 'Robtex_IP_Query', 'Robtex_Reverse_PDNS_Query', 'Robtex_Forward_PDNS_Query',
  'UnshortenLink', 'StopForumSpam', 'EmlParser', 'Mnemonic_pDNS_Public', 'CyberCrime-Tracker',
];

if (!ADMIN_PASSWORD) throw new Error('CORTEX_ADMIN_PASSWORD is required');
const basic = 'Basic ' + Buffer.from(`${ADMIN}:${ADMIN_PASSWORD}`).toString('base64');

async function call(method, path, { body, auth } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const ok = (r) => r.status >= 200 && r.status < 300;

console.log('==> Cortex: migrate index');
let r = await call('POST', '/api/maintenance/migrate', { body: {} });
console.log('    migrate', r.status);

console.log('==> Cortex: superadmin');
r = await call('POST', '/api/user', {
  body: { login: ADMIN, name: 'Administrator', roles: ['superadmin'], preferences: '{}', password: ADMIN_PASSWORD, organization: 'cortex' },
});
console.log('    create admin', r.status, ok(r) ? 'created' : '(probably exists)');
r = await call('GET', '/api/user/current', { auth: basic });
if (!ok(r)) throw new Error(`Cannot authenticate as admin: ${r.status} ${JSON.stringify(r.json)}`);

console.log(`==> Cortex: organisation ${ORG}`);
r = await call('GET', `/api/organization/${ORG}`, { auth: basic });
if (!ok(r)) {
  r = await call('POST', '/api/organization', { auth: basic, body: { name: ORG, description: 'MyHive SIRP', status: 'Active' } });
  if (!ok(r)) throw new Error(`Create org failed: ${r.status} ${JSON.stringify(r.json)}`);
}

console.log(`==> Cortex: API user ${API_USER}`);
r = await call('GET', `/api/user/${API_USER}`, { auth: basic });
if (!ok(r)) {
  r = await call('POST', '/api/user', {
    auth: basic,
    body: { login: API_USER, name: 'MyHive integration', roles: ['read', 'analyze', 'orgadmin'], organization: ORG },
  });
  if (!ok(r)) throw new Error(`Create user failed: ${r.status} ${JSON.stringify(r.json)}`);
}

let key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '';
if (key) {
  const check = await call('GET', '/api/user/current', { auth: `Bearer ${key}` });
  if (!ok(check)) key = '';
}
if (!key) {
  r = await call('POST', `/api/user/${API_USER}/key/renew`, { auth: basic });
  if (!ok(r)) throw new Error(`Key renew failed: ${r.status} ${JSON.stringify(r.json)}`);
  key = String(r.json).trim();
  writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
}
const bearer = `Bearer ${key}`;

console.log('==> Cortex: enabling free analyzers');
r = await call('GET', '/api/analyzerdefinition?range=all', { auth: bearer });
if (!ok(r)) throw new Error(`List definitions failed: ${r.status}`);
const definitions = r.json;
const enabled = await call('GET', '/api/analyzer?range=all', { auth: bearer });
if (!Array.isArray(enabled.json)) throw new Error(`List analyzers failed: ${enabled.status} ${JSON.stringify(enabled.json)}`);
const enabledIds = new Set(enabled.json.map((a) => a.analyzerDefinitionId));

// Pick the newest version per analyzer name
const latest = new Map();
for (const d of definitions) {
  if (!FREE_ANALYZERS.includes(d.name)) continue;
  const prev = latest.get(d.name);
  if (!prev || String(d.version).localeCompare(String(prev.version), undefined, { numeric: true }) > 0) latest.set(d.name, d);
}

for (const d of latest.values()) {
  if (enabledIds.has(d.id)) { console.log(`    = ${d.id} (already enabled)`); continue; }
  const configuration = { auto_extract_artifacts: false, check_tlp: true, max_tlp: 2, check_pap: true, max_pap: 2 };
  let missing = false;
  for (const item of d.configurationItems || []) {
    if (item.defaultValue !== undefined) configuration[item.name] = item.defaultValue;
    else if (item.required) missing = true;
  }
  if (missing) { console.log(`    - ${d.id} skipped (needs configuration)`); continue; }
  r = await call('POST', `/api/organization/analyzer/${d.id}`, {
    auth: bearer,
    body: { name: d.id, configuration, jobCache: 10, jobTimeout: 30 },
  });
  console.log(`    ${ok(r) ? '+' : '!'} ${d.id} ${ok(r) ? '' : r.status + ' ' + JSON.stringify(r.json)}`);
}
console.log('==> Cortex: enabling test responder');
r = await call('GET', '/api/responderdefinition?range=all', { auth: bearer });
const echo = (Array.isArray(r.json) ? r.json : []).filter((d) => d.name === 'DevTools_Echo_Responder')
  .sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
const enabledResponders = await call('GET', '/api/responder?range=all', { auth: bearer });
const enabledResponderIds = new Set((Array.isArray(enabledResponders.json) ? enabledResponders.json : []).map((x) => x.workerDefinitionId || x.responderDefinitionId));
if (echo && !enabledResponderIds.has(echo.id)) {
  const cfg = { check_tlp: false, max_tlp: 3, check_pap: false, max_pap: 3 };
  for (const item of echo.configurationItems || []) if (item.defaultValue !== undefined) cfg[item.name] = item.defaultValue;
  r = await call('POST', `/api/organization/responder/${echo.id}`, { auth: bearer, body: { name: echo.id, configuration: cfg, jobTimeout: 30 } });
  console.log(`    ${ok(r) ? '+' : '!'} ${echo.id} ${ok(r) ? '' : r.status + ' ' + JSON.stringify(r.json)}`);
} else if (echo) console.log(`    = ${echo.id} (already enabled)`);
console.log('==> Cortex bootstrap done');
