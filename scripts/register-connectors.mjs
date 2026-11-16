#!/usr/bin/env node
// Registers (or updates) existing Cortex / MISP servers in MyHive, then tests them.
// Idempotent: a connector with the same type + URL is updated instead of duplicated.
//
//   MYHIVE_URL=http://127.0.0.1:4100/api/v1 MYHIVE_LOGIN=admin@myhive.local MYHIVE_PASSWORD=... \
//   CORTEX_URL=https://cortex.local:9001 CORTEX_API_KEY=... CORTEX_VERIFY_TLS=false \
//   MISP_URL=https://misp.local MISP_API_KEY=... MISP_VERIFY_TLS=false MISP_FEEDER_MINUTES=15 \
//   node scripts/register-connectors.mjs
//
// Any of the CORTEX_* / MISP_* blocks can be omitted. MYHIVE_TOKEN (JWT or mh_ API key) can replace login/password.

const API = process.env.MYHIVE_URL || 'http://127.0.0.1:4100/api/v1';
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const bool = (v, d = true) => (v === undefined ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

let token = env('MYHIVE_TOKEN');

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.message || text}`);
  return data;
}

if (!token) {
  const login = env('MYHIVE_LOGIN', 'admin@myhive.local');
  const password = env('MYHIVE_PASSWORD');
  if (!password) throw new Error('Set MYHIVE_PASSWORD (or MYHIVE_TOKEN)');
  token = (await call('POST', '/auth/login', { login, password })).token;
}

const wanted = [];
if (env('CORTEX_URL')) {
  wanted.push({ type: 'cortex', name: env('CORTEX_NAME', 'Cortex'), url: env('CORTEX_URL'), apiKey: env('CORTEX_API_KEY'), verifyTls: bool(env('CORTEX_VERIFY_TLS')) });
}
if (env('MISP_URL')) {
  wanted.push({
    type: 'misp', name: env('MISP_NAME', 'MISP'), url: env('MISP_URL'), apiKey: env('MISP_API_KEY'), verifyTls: bool(env('MISP_VERIFY_TLS')),
    distribution: Number(env('MISP_DISTRIBUTION', 0)),
  });
}
if (!wanted.length) throw new Error('Nothing to do: set CORTEX_URL/CORTEX_API_KEY and/or MISP_URL/MISP_API_KEY');

const existing = await call('GET', '/connectors');
const norm = (u) => String(u).replace(/\/+$/, '').toLowerCase();
const saved = [];
for (const w of wanted) {
  if (!w.apiKey) throw new Error(`${w.type.toUpperCase()}_API_KEY is required`);
  const found = existing.find((c) => c.type === w.type && norm(c.url) === norm(w.url));
  const result = found ? await call('PATCH', `/connectors/${found.id}`, w) : await call('POST', '/connectors', w);
  saved.push(result);
  console.log(`${found ? 'updated' : 'created'} ${w.type} "${result.name}" → ${result.url}`);
}

for (const c of saved) {
  const status = await call('POST', `/connectors/${c.id}/test`);
  console.log(`  ${c.type}: ${status.ok ? `OK v${status.version}${c.type === 'cortex' ? ` · org ${status.organisation} · ${status.analyzers} analyzers` : ''}` : `ERROR ${status.error}`}`);
}

const misp = saved.find((c) => c.type === 'misp');
const minutes = Number(env('MISP_FEEDER_MINUTES', 0));
if (misp && minutes > 0) {
  const feeders = await call('GET', '/misp/feeders');
  const feeder = feeders.find((f) => f.config?.connectorId === misp.id);
  const body = { name: `${misp.name} (cada ${minutes} min)`, connectorId: misp.id, intervalMinutes: minutes, last: env('MISP_FEEDER_WINDOW', '1d'), limit: 100, enabled: true };
  const f = feeder ? await call('PATCH', `/misp/feeders/${feeder.id}`, body) : await call('POST', '/misp/feeders', body);
  console.log(`${feeder ? 'updated' : 'created'} MISP feeder "${f.name}" (every ${minutes} min, window ${body.last})`);
}
