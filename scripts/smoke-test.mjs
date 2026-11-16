#!/usr/bin/env node
// End-to-end functional test of MyHive (API + Cortex + MISP).
//   MYHIVE_URL=http://127.0.0.1:4100/api/v1 MYHIVE_LOGIN=admin@myhive.local MYHIVE_PASSWORD=... node scripts/smoke-test.mjs
// Creates its own data and deletes it at the end. Integration checks are skipped if no Cortex/MISP connector exists.
// Safe on real environments: it only runs the test responder DevTools_Echo (never a real responder) and only
// creates MISP events when SMOKE_MISP_WRITE=1.

const API = process.env.MYHIVE_URL || 'http://127.0.0.1:4100/api/v1';
const LOGIN = process.env.MYHIVE_LOGIN || 'admin@myhive.local';
const PASSWORD = process.env.MYHIVE_PASSWORD || 'admin123';
const stamp = Date.now().toString(36);
const MISP_WRITE = process.env.SMOKE_MISP_WRITE === '1';

let token = '';
let passed = 0;
let failed = 0;
const cleanup = [];

async function call(method, path, body, { auth = token, expect } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (expect !== undefined && res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (expected ${expect}): ${text.slice(0, 300)}`);
  if (expect === undefined && !res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function test(name, fn) {
  try {
    const note = await fn();
    passed++;
    console.log(`  \x1b[32m✔\x1b[0m ${name}${note ? ` \x1b[90m(${note})\x1b[0m` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✘ ${name}\x1b[0m\n      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitFor(fn, { timeoutMs = 180000, everyMs = 3000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function newCase(extra = {}) {
  const c = await call('POST', '/cases', { title: `smoke ${stamp} ${extra.title || ''}`.trim(), description: 'smoke test', ...extra });
  cleanup.push(() => call('DELETE', `/cases/${c.id}?force=true`, undefined, { expect: undefined }).catch(() => undefined));
  return c;
}

console.log(`MyHive smoke test → ${API}\n`);

console.log('Core');
await test('health', async () => {
  const h = await call('GET', '/health', undefined, { auth: '' });
  assert(h.status === 'ok', JSON.stringify(h));
});
await test('login + /auth/me', async () => {
  token = (await call('POST', '/auth/login', { login: LOGIN, password: PASSWORD }, { auth: '' })).token;
  const me = await call('GET', '/auth/me');
  assert(me.permissions.length > 0, 'no permissions');
  return `${me.login} · ${me.profile} · ${me.permissions.length} permisos`;
});
await test('login sin cuerpo → 400 (antes 500)', async () => {
  await call('POST', '/auth/login', {}, { auth: '', expect: 400 });
});
await test('API key personal sirve para autenticarse y se puede revocar', async () => {
  const key = await call('POST', '/auth/api-keys', { name: `smoke ${stamp}` });
  const me = await call('GET', '/auth/me', undefined, { auth: key.key });
  assert(me.login === LOGIN.toLowerCase(), 'wrong user');
  await call('DELETE', `/auth/api-keys/${key.id}`);
  await call('GET', '/auth/me', undefined, { auth: key.key, expect: 401 });
});

console.log('\nCasos');
let mainCase;
await test('crear caso guarda los tags', async () => {
  mainCase = await newCase({ title: 'principal', tags: ['smoke', 'phishing'], severity: 3 });
  assert(JSON.stringify(mainCase.tags) === '["smoke","phishing"]', `tags=${JSON.stringify(mainCase.tags)}`);
});
await test('editar caso actualiza los tags', async () => {
  const c = await call('PATCH', `/cases/${mainCase.id}`, { tags: ['smoke', 'editado'] });
  assert(c.tags.includes('editado') && !c.tags.includes('phishing'), JSON.stringify(c.tags));
});
await test('buscar por #número y por tag', async () => {
  const byNumber = await call('GET', `/cases?search=%23${mainCase.number}`);
  assert(byNumber.items.some((c) => c.id === mainCase.id), 'not found by number');
  const byTag = await call('GET', '/cases?search=editado');
  assert(byTag.items.some((c) => c.id === mainCase.id), 'not found by tag');
});
await test('ordenar por campo inexistente → 400 (antes 500)', async () => {
  await call('GET', '/cases?sort=-noExiste', undefined, { expect: 400 });
  await call('GET', '/alerts?sort=password', undefined, { expect: 400 });
});
await test('reabrir caso inexistente → 404 (antes 500)', async () => {
  await call('POST', '/cases/00000000-0000-0000-0000-000000000000/reopen', undefined, { expect: 404 });
});
await test('tarea: completar y reabrir limpia endDate', async () => {
  const t = await call('POST', `/cases/${mainCase.id}/tasks`, { title: 'Contener host' });
  await call('PATCH', `/tasks/${t.id}`, { status: 'Completed', endDate: new Date().toISOString() });
  const reopened = await call('PATCH', `/tasks/${t.id}`, { status: 'InProgress', endDate: null });
  assert(reopened.endDate === null, `endDate=${reopened.endDate}`);
});
await test('fusionar observables duplicados conserva IOC/sighted/tags', async () => {
  await call('POST', `/cases/${mainCase.id}/observables`, { dataType: 'ip', data: '203.0.113.7', ioc: true, tags: ['a'] });
  await call('POST', `/cases/${mainCase.id}/observables`, { dataType: 'ip', data: '203.0.113.7', sighted: true, tags: ['b'] });
  const r = await call('POST', `/cases/${mainCase.id}/observables/_merge`);
  const c = await call('GET', `/cases/${mainCase.id}`);
  const o = c.observables.filter((x) => x.data === '203.0.113.7');
  assert(r.removed === 1 && o.length === 1, `removed=${r.removed} left=${o.length}`);
  assert(o[0].ioc && o[0].sighted && o[0].tags.includes('a') && o[0].tags.includes('b'), JSON.stringify(o[0]));
});
await test('fusionar casos mueve comentarios y marca los originales como Duplicated', async () => {
  const a = await newCase({ title: 'merge A' });
  const b = await newCase({ title: 'merge B', tags: ['merge-tag'] });
  await call('POST', `/cases/${a.id}/comments`, { message: 'comentario a conservar' });
  const merged = await call('POST', `/cases/${a.id}/merge`, { ids: [b.id] });
  cleanup.push(() => call('DELETE', `/cases/${merged.id}?force=true`).catch(() => undefined));
  assert(merged.comments.some((cm) => cm.message === 'comentario a conservar'), 'comment lost');
  assert(merged.tags.includes('merge-tag'), `tags=${merged.tags}`);
  const src = await call('GET', `/cases/${b.id}`);
  assert(src.stage === 'Closed' && src.status?.value === 'Duplicated', `${src.stage}/${src.status?.value}`);
});
await test('eliminar caso con force lo borra de verdad', async () => {
  const c = await newCase({ title: 'borrar' });
  await call('DELETE', `/cases/${c.id}?force=true`);
  await call('GET', `/cases/${c.id}`, undefined, { expect: 404 });
});

console.log('\nAlertas');
let alert;
await test('crear alerta guarda los tags', async () => {
  alert = await call('POST', '/alerts', {
    type: 'smoke', source: 'smoke-test', sourceRef: `ref-${stamp}`, title: `smoke alert ${stamp}`, description: 'd',
    tags: ['t1', 't2'], observables: [{ dataType: 'domain', data: 'evil.example' }],
  });
  cleanup.push(() => call('DELETE', `/alerts/${alert.id}`).catch(() => undefined));
  assert(JSON.stringify(alert.tags) === '["t1","t2"]', JSON.stringify(alert.tags));
});
await test('alerta duplicada (type/source/sourceRef) → 409 (antes 500)', async () => {
  await call('POST', '/alerts', { type: 'smoke', source: 'smoke-test', sourceRef: `ref-${stamp}`, title: 'dup', description: 'd' }, { expect: 409 });
});
await test('importar alerta a caso hereda tags y observables', async () => {
  const c = await call('POST', `/alerts/${alert.id}/case`, {});
  cleanup.push(() => call('DELETE', `/cases/${c.id}?force=true`).catch(() => undefined));
  assert(c.tags.includes('t1') && c.observables.some((o) => o.data === 'evil.example'), JSON.stringify({ tags: c.tags, obs: c.observables.length }));
});
await test('merge de alerta a caso inexistente → 404', async () => {
  const a2 = await call('POST', '/alerts', { type: 'smoke', source: 'smoke-test', sourceRef: `ref2-${stamp}`, title: 'a2', description: 'd' });
  cleanup.push(() => call('DELETE', `/alerts/${a2.id}`).catch(() => undefined));
  await call('POST', `/alerts/${a2.id}/merge/00000000-0000-0000-0000-000000000000`, undefined, { expect: 404 });
});

console.log('\nAdministración');
await test('endpoint con config JSON en texto se guarda como objeto', async () => {
  const e = await call('POST', '/endpoints', { name: `smoke ${stamp}`, type: 'webhook', config: '{"url":"https://example.org/hook"}' });
  cleanup.push(() => call('DELETE', `/endpoints/${e.id}`).catch(() => undefined));
  assert(e.config?.url === 'https://example.org/hook', JSON.stringify(e.config));
});

// ------------------------------------------------------------------ integrations
const connectors = await call('GET', '/connectors/status').catch(() => []);
const cortex = connectors.find((c) => c.type === 'cortex');
const misp = connectors.find((c) => c.type === 'misp');

console.log('\nCortex');
if (!cortex) console.log('  - sin conector Cortex: omitido');
else {
  await test('conector Cortex responde', async () => {
    assert(cortex.status.ok, cortex.status.error);
    return `v${cortex.status.version}, ${cortex.status.analyzers} analizadores`;
  });
  let obs;
  await test('analizador sobre una IP termina con reporte (TorProject si está habilitado)', async () => {
    obs = await call('POST', `/cases/${mainCase.id}/observables`, { dataType: 'ip', data: '185.220.101.1', ioc: true });
    const { analyzers } = await call('GET', '/cortex/analyzers?dataType=ip');
    const tor = analyzers.find((a) => a.name.startsWith('TorProject')) || analyzers[0];
    assert(tor, 'no analyzer for dataType ip is enabled in the Cortex organisation');
    await call('POST', `/observables/${obs.id}/analyze`, { analyzers: [{ connectorId: tor.connectorId, analyzerId: tor.id }] });
    const report = await waitFor(async () => {
      const list = await call('GET', `/observables/${obs.id}/reports`);
      return list.find((r) => !['Waiting', 'InProgress'].includes(r.status));
    });
    assert(report.status === 'Success', `${tor.name}: ${report.errorMessage}`);
    if (tor.name.startsWith('TorProject')) assert(report.taxonomies.length > 0, 'report has no taxonomies');
    return `${tor.name}: ` + report.taxonomies.map((t) => `${t.level}:${t.predicate}=${t.value}`).join(', ');
  });
  await test('responder (echo) sobre el caso termina en Success', async () => {
    const { responders } = await call('GET', '/cortex/responders/case');
    const echo = responders.find((r) => r.name.startsWith('DevTools_Echo'));
    if (!echo) return `omitido: habilita DevTools_Echo_Responder en Cortex para probarlo (${responders.length} responders disponibles)`;
    const job = await call('POST', `/cortex/responders/case/${mainCase.id}`, { connectorId: echo.connectorId, responderId: echo.id, responderName: echo.name });
    const done = await waitFor(async () => {
      const list = await call('GET', `/cortex/actions/case/${mainCase.id}`);
      const j = list.find((x) => x.id === job.id);
      return j && !['Waiting', 'InProgress'].includes(j.status) && j;
    });
    assert(done.status === 'Success', JSON.stringify(done.result));
  });
}

console.log('\nMISP');
if (!misp) console.log('  - sin conector MISP: omitido');
else {
  await test('conector MISP responde', async () => {
    assert(misp.status.ok, misp.status.error);
    return `v${misp.status.version}`;
  });
  let eventId;
  if (!MISP_WRITE) console.log('  - exportar/buscar evento propio omitido (crea eventos en MISP): usa SMOKE_MISP_WRITE=1');
  if (MISP_WRITE) await test('exportar caso a MISP y re-exportar sin duplicar', async () => {
    await call('POST', `/cases/${mainCase.id}/observables`, { dataType: 'domain', data: `smoke-${stamp}.example`, ioc: true });
    const first = await call('POST', `/cases/${mainCase.id}/misp-export`, {});
    eventId = first.eventId;
    const second = await call('POST', `/cases/${mainCase.id}/misp-export`, {});
    assert(first.attributesAdded > 0 && second.attributesAdded === 0 && second.eventId === eventId, JSON.stringify({ first, second }));
    return `evento #${eventId}, ${first.attributesAdded} atributos`;
  });
  if (MISP_WRITE) await test('buscar observable en MISP encuentra el evento exportado', async () => {
    const c = await call('GET', `/cases/${mainCase.id}`);
    const o = c.observables.find((x) => x.data === `smoke-${stamp}.example`);
    const r = await call('POST', `/observables/${o.id}/misp-search`, {});
    assert(r.total > 0 && r.results.some((x) => x.hits.some((h) => String(h.eventId) === String(eventId))), JSON.stringify(r));
  });
  await test('sincronizar MISP → alertas (y no re-importa eventos de MyHive)', async () => {
    const r = await call('POST', '/misp/sync', { last: '1d', limit: 20 });
    const own = await call('GET', `/alerts?type=misp&search=${encodeURIComponent(`[Nuestracolmena #${mainCase.number}]`)}`);
    assert(own.total === 0, 'imported its own exported event');
    return `${r.events} eventos, ${r.created} nuevas, ${r.updated} actualizadas`;
  });
  await test('feeder MISP: crear, ejecutar y borrar', async () => {
    const f = await call('POST', '/misp/feeders', { name: `smoke ${stamp}`, connectorId: misp.id, intervalMinutes: 60, last: '1d', enabled: false });
    const ran = await call('POST', `/misp/feeders/${f.id}/run`);
    await call('DELETE', `/misp/feeders/${f.id}`);
    assert(ran.config.lastResult?.ok, JSON.stringify(ran.config.lastResult));
  });
}

// ------------------------------------------------------------------ cleanup
for (const fn of cleanup.reverse()) await fn();
// Remove this run's endpoint and any leftover endpoints from older smoke runs.
const endpoints = await call('GET', '/endpoints').catch(() => []);
for (const e of endpoints.filter((x) => x.type === 'webhook' && /^smoke [a-z0-9]+$/.test(x.name))) {
  await call('DELETE', `/endpoints/${e.id}`).catch(() => undefined);
}

console.log(`\n${passed} OK · ${failed} fallidos`);
process.exit(failed ? 1 : 0);
