#!/usr/bin/env node
// End-to-end test of file observables (upload, hashes, download/zip, Cortex, compat routes, MISP export).
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/file-observables-test.mjs
// Creates its own data and deletes it at the end. MISP export only runs with SMOKE_MISP_WRITE=1.

import { Blob } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = (process.env.MYHIVE_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const V1 = `${ORIGIN}/api/v1`;
const LOGIN = process.env.MYHIVE_LOGIN || 'admin@myhive.local';
const PASSWORD = process.env.MYHIVE_PASSWORD || 'admin123';
const MISP_WRITE = process.env.SMOKE_MISP_WRITE === '1';
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const filename = `eicar-${stamp}.txt`;

let token = '';
let passed = 0;
let failed = 0;
const cleanup = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(method, path, body, options = {}) {
  const headers = { ...(options.headers || {}) };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (options.auth !== '') headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path.startsWith('http') ? path : `${V1}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (options.expect !== undefined) {
    if (res.status !== options.expect) throw new Error(`${method} ${path} → ${res.status} (expected ${options.expect}): ${text.slice(0, 400)}`);
  } else if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
}

async function raw(path, { expect } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${V1}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (expect !== undefined) {
    if (res.status !== expect) throw new Error(`GET ${path} → ${res.status} (expected ${expect}): ${buffer.toString('utf8').slice(0, 200)}`);
  } else if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${buffer.toString('utf8').slice(0, 200)}`);
  }
  return { status: res.status, buffer };
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

async function waitFor(fn, { timeoutMs = 180000, everyMs = 3000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout after ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

function uploadForm(content, name = filename, fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  return form;
}

async function newCase(title) {
  const created = await call('POST', '/cases', { title: `file-observables ${stamp} ${title}`, description: 'file observables test' });
  cleanup.push(() => call('DELETE', `/cases/${created.id}?force=true`).catch(() => undefined));
  return created;
}

function trackFileObservable(attachment, observableId) {
  if (attachment?.id) cleanup.push(() => call('DELETE', `/attachments/${attachment.id}`).catch(() => undefined));
  if (observableId) cleanup.push(() => call('DELETE', `/observables/${observableId}`).catch(() => undefined));
}

async function uploadAttachment(objectType, objectId, name, content = EICAR) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  form.append('objectType', objectType);
  form.append('objectId', objectId);
  return call('POST', '/attachments', form);
}

async function assertAttachmentsGone(objectType, objectId) {
  const rows = await call('GET', `/attachments?objectType=${encodeURIComponent(objectType)}&objectId=${encodeURIComponent(objectId)}`);
  assert(Array.isArray(rows) && rows.length === 0, `${objectType}/${objectId} still has ${Array.isArray(rows) ? rows.length : '?'} attachment row(s)`);
}

function assertFileGone(storageKey) {
  const stillThere = uploadDirs().filter((dir) => existsSync(join(dir, storageKey)));
  assert(stillThere.length === 0, `${storageKey} still on disk: ${stillThere.join(', ')}`);
}

function hash(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex');
}

function uploadDirs() {
  return [...new Set([
    process.env.UPLOAD_DIR,
    join(process.cwd(), 'apps/api/uploads'),
    join(process.cwd(), 'uploads'),
  ].filter(Boolean))];
}

console.log(`MyHive file observables test → ${ORIGIN}\n`);

const md5 = hash('md5', EICAR);
const sha1 = hash('sha1', EICAR);
const sha256 = hash('sha256', EICAR);
let caseA;
let caseB;
let fileObservable;

await test('login', async () => {
  const result = await call('POST', '/auth/login', { login: LOGIN, password: PASSWORD }, { auth: '' });
  token = result.token;
  assert(token, 'no token');
  return result.user?.login;
});

await test('crear casos de prueba', async () => {
  caseA = await newCase('A');
  caseB = await newCase('B');
  assert(caseA.id && caseB.id, 'missing case ids');
  return `#${caseA.number}, #${caseB.number}`;
});

await test('subir fichero crea observable file + hashes md5/sha1/sha256', async () => {
  const result = await call('POST', `/cases/${caseA.id}/observables/file`, uploadForm(EICAR, filename, { message: 'muestra EICAR' }));
  assert(result.files?.length === 1, JSON.stringify(result).slice(0, 400));
  const file = result.files[0].observable;
  trackFileObservable(file.attachment, file.id);
  assert(file.dataType === 'file', `dataType=${file.dataType}`);
  assert(file.data === filename, `data=${file.data}`);
  assert(file.dataHash === sha256, `dataHash=${file.dataHash}`);
  assert(file.attachment?.sha256 === sha256, `attachment sha256=${file.attachment?.sha256}`);
  assert((file.attachment?.hashes || []).length === 3, JSON.stringify(file.attachment?.hashes));
  const hashes = result.observables.filter((o) => o.dataType === 'hash').map((o) => o.data).sort();
  assert(hashes.length === 3, `hashes=${hashes.length}`);
  assert(hashes.includes(md5) && hashes.includes(sha1) && hashes.includes(sha256), hashes.join(','));
  fileObservable = file;
  return `${filename} · ${hashes.length} hashes`;
});

await test('el mismo fichero en otro caso correlaciona', async () => {
  const result = await call('POST', `/cases/${caseB.id}/observables/file`, uploadForm(EICAR, filename));
  const file = result.files[0].observable;
  trackFileObservable(file.attachment, file.id);
  assert(file.dataHash === sha256, `dataHash=${file.dataHash}`);
  const sightings = await call('GET', `/observables/${file.id}/sightings`);
  assert(sightings.some((item) => item.kind === 'case' && item.id === caseA.id), JSON.stringify(sightings));
  const caseAData = await call('GET', `/cases/${caseA.id}`);
  const first = caseAData.observables.find((o) => o.id === fileObservable.id);
  assert(first.seenCount >= 1, `seenCount=${first.seenCount}`);
  return `${sightings.length} avistamiento(s)`;
});

await test('descarga normal devuelve el contenido original', async () => {
  const { buffer } = await raw(`/observables/${fileObservable.id}/download`);
  assert(buffer.toString() === EICAR, `length=${buffer.length}`);
});

await test('descarga ZIP protegida empieza por PK', async () => {
  const { buffer } = await raw(`/observables/${fileObservable.id}/download?zip=1`);
  assert(buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b, `first bytes=${buffer.subarray(0, 4).toString('hex')}`);
  return `${buffer.length} bytes`;
});

await test('Cortex FileInfo analiza el fichero', async () => {
  const connectors = await call('GET', '/connectors/status').catch(() => []);
  const cortex = connectors.find((c) => c.type === 'cortex');
  if (!cortex) return 'omitido: sin conector Cortex';
  const { analyzers } = await call('GET', '/cortex/analyzers?dataType=file');
  const analyzer = analyzers.find((a) => a.name.startsWith('FileInfo'));
  if (!analyzer) return 'omitido: FileInfo no habilitado para file';
  const launched = await call('POST', `/observables/${fileObservable.id}/analyze`, {
    analyzers: [{ connectorId: analyzer.connectorId, analyzerId: analyzer.id }],
  });
  assert(!launched.errors?.length, JSON.stringify(launched.errors));
  const report = await waitFor(async () => {
    const list = await call('GET', `/observables/${fileObservable.id}/reports`);
    return list.find((r) => !['Waiting', 'InProgress'].includes(r.status));
  });
  assert(report.status === 'Success', `${analyzer.name}: ${report.errorMessage}`);
  assert((report.taxonomies || []).length > 0, 'report has no taxonomies');
  return `${analyzer.name}: ${report.taxonomies.map((t) => `${t.level}:${t.predicate}=${t.value}`).join(', ')}`;
});

await test('ruta TheHive 5 multipart crea observable file', async () => {
  const caseC = await newCase('TH5');
  const form = new FormData();
  form.append('attachment', new Blob([EICAR], { type: 'text/plain' }), `th5-${stamp}.txt`);
  form.append('_json', JSON.stringify({ dataType: 'file', message: 'thehive5 upload', tlp: 2, ioc: false, tags: ['compat'] }));
  const created = await call('POST', `/case/${caseC.id}/observable`, form);
  assert(created.dataType === 'file', `dataType=${created.dataType}`);
  assert(created.data === `th5-${stamp}.txt`, `data=${created.data}`);
  assert((created.attachment?.hashes || []).length === 3, JSON.stringify(created.attachment));
  trackFileObservable(created.attachment, created._id || created.id);
  return created._id;
});

await test('ruta TheHive 4 multipart artifact crea observable file', async () => {
  const form = new FormData();
  form.append('attachment', new Blob([EICAR], { type: 'text/plain' }), `th4-${stamp}.txt`);
  form.append('_json', JSON.stringify({ dataType: 'file', message: 'thehive4 upload', tlp: 2 }));
  const created = await call('POST', `${ORIGIN}/api/case/${caseA.id}/artifact`, form);
  assert(created.dataType === 'file', `dataType=${created.dataType}`);
  assert(created.data === `th4-${stamp}.txt`, `data=${created.data}`);
  assert((created.attachment?.hashes || []).length === 3, JSON.stringify(created.attachment));
  trackFileObservable(created.attachment, created.id);
  return created.id;
});

await test('eliminar el observable borra el fichero del disco', async () => {
  const form = uploadForm(EICAR, `delete-${stamp}.txt`);
  const created = await call('POST', `/cases/${caseB.id}/observables/file`, form);
  const file = created.files[0].observable;
  assert(file.attachment?.storageKey, 'no storageKey');
  await raw(`/observables/${file.id}/download`);
  await call('DELETE', `/observables/${file.id}`);
  await raw(`/observables/${file.id}/download`, { expect: 404 });
  const dirs = uploadDirs();
  const stillThere = dirs.filter((dir) => existsSync(join(dir, file.attachment.storageKey)));
  assert(stillThere.length === 0, `still on disk: ${stillThere.join(', ')}`);
  return file.attachment.storageKey;
});

await test('force-delete de caso elimina adjuntos de caso, log y observable', async () => {
  const created = await newCase('delete-tree');
  const uploaded = await call('POST', `/cases/${created.id}/observables/file`, uploadForm(EICAR, `tree-${stamp}.txt`));
  const file = uploaded.files[0].observable;
  trackFileObservable(file.attachment, file.id);
  const task = await call('POST', `/cases/${created.id}/tasks`, { title: `delete-tree task ${stamp}` });
  const log = await call('POST', `/tasks/${task.id}/logs`, { message: 'log con adjunto' });
  const caseAttachment = await uploadAttachment('case', created.id, `case-${stamp}.txt`);
  const logAttachment = await uploadAttachment('log', log.id, `log-${stamp}.txt`);
  const keys = [file.attachment.storageKey, caseAttachment.storageKey, logAttachment.storageKey];
  await call('DELETE', `/cases/${created.id}?force=true`);
  await assertAttachmentsGone('case', created.id);
  await assertAttachmentsGone('log', log.id);
  await assertAttachmentsGone('observable', file.id);
  for (const key of keys) assertFileGone(key);
  return `${keys.length} fichero(s) eliminados`;
});

await test('delete de alerta elimina su observable file y adjuntos', async () => {
  const alert = await call('POST', '/alerts', {
    type: 'file-observables', source: 'file-observables-test', sourceRef: `delete-alert-${stamp}`,
    title: `alert delete ${stamp}`, description: 'delete alert attachments', severity: 2,
  });
  cleanup.push(() => call('DELETE', `/alerts/${alert.id}`).catch(() => undefined));
  const uploaded = await call('POST', `/alerts/${alert.id}/observables/file`, uploadForm(EICAR, `alert-${stamp}.txt`));
  const file = uploaded.files[0].observable;
  trackFileObservable(file.attachment, file.id);
  const alertAttachment = await uploadAttachment('alert', alert.id, `alert-direct-${stamp}.txt`);
  const keys = [file.attachment.storageKey, alertAttachment.storageKey];
  await call('DELETE', `/alerts/${alert.id}`);
  await assertAttachmentsGone('alert', alert.id);
  await assertAttachmentsGone('observable', file.id);
  await raw(`/observables/${file.id}/download`, { expect: 404 });
  for (const key of keys) assertFileGone(key);
  return `${keys.length} fichero(s) eliminados`;
});

await test('sweep de adjuntos huérfanos', async () => {
  const result = await call('POST', '/admin/attachments/sweep');
  assert(typeof result.rowsDeleted === 'number' && typeof result.filesDeleted === 'number', JSON.stringify(result));
  return JSON.stringify(result);
});

if (MISP_WRITE) {
  await test('exportar caso a MISP incluye atributo attachment', async () => {
    const connectors = await call('GET', '/connectors/status').catch(() => []);
    if (!connectors.some((c) => c.type === 'misp')) return 'omitido: sin conector MISP';
    const exported = await call('POST', `/cases/${caseA.id}/misp-export`, {});
    const attribute = (exported.attributes || []).find((a) => a.type === 'attachment' || a.type === 'malware-sample');
    assert(attribute, JSON.stringify(exported.attributes || []));
    await call('DELETE', `/misp/events/${exported.eventId}`, {});
    return `evento #${exported.eventId}: ${attribute.type}`;
  });
} else {
  console.log('SKIP exportación MISP (usa SMOKE_MISP_WRITE=1 para probarla)');
}

for (const fn of cleanup.reverse()) await fn();

console.log(`\n${passed} OK · ${failed} fallidos`);
process.exit(failed ? 1 : 0);
