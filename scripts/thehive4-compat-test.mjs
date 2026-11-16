#!/usr/bin/env node
// End-to-end compatibility test: replays what thehive4py 1.x sends against MyHive.
// It creates its own objects and deletes them at the end.
//   MYHIVE_URL=http://127.0.0.1:4100 MYHIVE_LOGIN=admin@myhive.local MYHIVE_PASSWORD=... node scripts/thehive4-compat-test.mjs

import { Blob } from 'node:buffer';

const ORIGIN = (process.env.MYHIVE_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const V1 = `${ORIGIN}/api/v1`;
const API = `${ORIGIN}/api`;
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

async function call(method, url, body, options = {}) {
  const headers = { ...(options.headers || {}) };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (options.auth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64')}`;
  } else if (options.auth !== 'none' && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (options.expect !== undefined) {
    if (res.status !== options.expect) throw new Error(`${method} ${url} → ${res.status} (expected ${options.expect}): ${text.slice(0, 400)}`);
  } else if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
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

console.log(`MyHive TheHive 4 compatibility test → ${ORIGIN}\n`);

let me;
let organisation;
await test('login (native) and pick organisation', async () => {
  const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD }, { auth: 'none' });
  token = result.token;
  me = result.user;
  organisation = result.organisations?.[0]?.name;
  assert(token, 'no token');
  assert(organisation, 'no organisation');
  return `${me.login} @ ${organisation}`;
});

await test('GET /api/status (no auth)', async () => {
  const result = await call('GET', `${API}/status`, undefined, { auth: 'none' });
  assert(result?.versions?.TheHive, `versions=${JSON.stringify(result?.versions)}`);
  assert(Array.isArray(result?.config?.authType) && result.config.authType.includes('key') && result.config.authType.includes('session'), `config=${JSON.stringify(result?.config)}`);
  assert(result.config.protectDownloadsWith === 'malware', `protectDownloadsWith=${result.config.protectDownloadsWith}`);
  return result.versions.TheHive;
});

await test('GET /api/user/current with Bearer', async () => {
  const result = await call('GET', `${API}/user/current`);
  assert(result?._type === 'user', `_type=${result?._type}`);
  assert(result.login === me.login, `login=${result.login}`);
  assert(result.id && result.id === result._id, 'id/_id mismatch');
  return result.login;
});

await test('GET /api/user/current with Basic', async () => {
  const result = await call('GET', `${API}/user/current`, undefined, { auth: 'basic' });
  assert(result?._type === 'user', `_type=${result?._type}`);
  assert(result.login === me.login, `login=${result.login}`);
  return 'Basic OK';
});

const sourceRef = `wazuh-${stamp}`;
const searchFrom = Date.now() - 1000;
let alert;
await test('create alert with artifacts and typed customFields', async () => {
  alert = await call('POST', `${API}/alert`, {
    title: `Wazuh alert ${stamp}`,
    description: 'Created by the TheHive 4 compatibility test',
    type: 'wazuh',
    source: 'wazuh',
    sourceRef,
    severity: 3,
    tlp: 2,
    pap: 2,
    status: 'New',
    date: Date.now(),
    tags: ['wazuh', 'compat'],
    artifacts: [
      { dataType: 'ip', data: `198.51.100.${(Date.now() % 200) + 10}`, message: 'Source IP', tlp: 2, pap: 2, ioc: true, tags: ['net'] },
    ],
    customFields: {
      'wazuh-rule': { string: '5710', order: 0 },
      score: { number: 12, order: 1 },
      enabled: { boolean: true, order: 2 },
      seen: { date: Date.now(), order: 3 },
    },
  });
  cleanup.push(() => call('DELETE', `${API}/alert/${alert.id}`).catch(() => undefined));
  assert(alert.id && alert._id === alert.id, 'id/_id mismatch');
  assert(alert._type === 'alert', `_type=${alert._type}`);
  assert(typeof alert.date === 'number' && alert.date > 0, `date=${alert.date}`);
  assert(typeof alert.createdAt === 'number', `createdAt=${alert.createdAt}`);
  assert(alert.status === 'New', `status=${alert.status}`);
  assert(Array.isArray(alert.artifacts) && alert.artifacts.length === 1, `artifacts=${JSON.stringify(alert.artifacts)}`);
  assert(alert.artifacts[0]._type === 'case_artifact', `artifact _type=${alert.artifacts[0]._type}`);
  assert(alert.customFields['wazuh-rule'] === '5710', JSON.stringify(alert.customFields));
  assert(alert.customFields.score === 12, JSON.stringify(alert.customFields));
  assert(alert.customFields.enabled === true, JSON.stringify(alert.customFields));
  assert(typeof alert.customFields.seen === 'number', JSON.stringify(alert.customFields));
  assert(alert.tags.includes('wazuh'), JSON.stringify(alert.tags));
  return `${alert.id} · ${alert.artifacts.length} artifact(s)`;
});

await test('get alert', async () => {
  const result = await call('GET', `${API}/alert/${alert.id}`);
  assert(result.id === alert.id && result._type === 'alert', JSON.stringify(result).slice(0, 200));
  assert(result.artifacts.length === 1, 'artifact missing');
  return result.title;
});

await test('search alerts with _and/_field/_between + range + sort', async () => {
  const result = await call('POST', `${API}/alert/_search`, {
    query: {
      _and: [
        { _field: 'sourceRef', _value: sourceRef },
        { _between: { _field: 'date', _from: searchFrom, _to: Date.now() + 60000 } },
      ],
    },
    range: '0-10',
    sort: '-createdAt',
  });
  assert(Array.isArray(result), `result=${JSON.stringify(result).slice(0, 200)}`);
  assert(result.some((item) => item.id === alert.id), `alert not found: ${JSON.stringify(result).slice(0, 300)}`);
  assert(result.every((item) => item._type === 'alert'), 'wrong _type in search results');
  return `${result.length} result(s)`;
});

await test('search alerts with _gt/_in/_string/_not', async () => {
  const result = await call('POST', `${API}/alert/_search`, {
    query: {
      _and: [
        { _gt: { date: searchFrom } },
        { _in: { _field: 'severity', _values: [3, 4] } },
        { _string: `Wazuh alert ${stamp}` },
        { _not: { _field: 'sourceRef', _value: `missing-${stamp}` } },
      ],
    },
    range: '0-10',
  });
  assert(Array.isArray(result) && result.some((item) => item.id === alert.id), `alert not found: ${JSON.stringify(result).slice(0, 300)}`);
  return `${result.length} result(s)`;
});

await test('mark alert as read and unread', async () => {
  const read = await call('POST', `${API}/alert/${alert.id}/markAsRead`);
  assert(read.read === true, `read=${read.read}`);
  const unread = await call('POST', `${API}/alert/${alert.id}/markAsUnread`);
  assert(unread.read === false, `read=${unread.read}`);
  return 'read/unread';
});

let alertArtifact;
await test('add artifact to alert', async () => {
  alertArtifact = await call('POST', `${API}/alert/${alert.id}/artifact`, {
    dataType: 'domain',
    data: `evil-${stamp}.example`,
    message: 'Added by thehive4py',
    tlp: 2,
    pap: 2,
    tags: ['dns'],
  });
  cleanup.push(() => call('DELETE', `${API}/case/artifact/${alertArtifact.id}`).catch(() => undefined));
  assert(alertArtifact._type === 'case_artifact', JSON.stringify(alertArtifact).slice(0, 200));
  assert(alertArtifact.dataType === 'domain' && alertArtifact.data.includes(stamp), 'wrong artifact');
  return alertArtifact.data;
});

await test('update alert (Updated status)', async () => {
  const result = await call('PATCH', `${API}/alert/${alert.id}`, {
    severity: 4,
    status: 'Updated',
    tags: ['updated'],
  });
  assert(result.severity === 4, `severity=${result.severity}`);
  assert(result.status === 'Updated', `status=${result.status}`);
  assert(result.tags.includes('updated'), JSON.stringify(result.tags));
  return `severity=${result.severity} status=${result.status}`;
});

let caseItem;
await test('promote alert to case with createCase', async () => {
  caseItem = await call('POST', `${API}/alert/${alert.id}/createCase`, {});
  cleanup.push(() => call('DELETE', `${API}/case/${caseItem.id}`).catch(() => undefined));
  assert(caseItem.id && caseItem._id === caseItem.id, 'id/_id mismatch');
  assert(caseItem._type === 'case', `_type=${caseItem._type}`);
  assert(typeof caseItem.caseId === 'number', `caseId=${caseItem.caseId}`);
  assert(caseItem.status === 'Open', `status=${caseItem.status}`);
  assert(caseItem.artifacts.length >= 2, `artifacts=${caseItem.artifacts?.length}`);
  return `#${caseItem.caseId}`;
});

let secondAlert;
await test('create second alert and merge it into the case', async () => {
  secondAlert = await call('POST', `${API}/alert`, {
    title: `Wazuh merge ${stamp}`,
    type: 'wazuh',
    source: 'wazuh',
    sourceRef: `merge-${stamp}`,
    severity: 2,
    tlp: 2,
    pap: 2,
    date: Date.now(),
    tags: ['merge'],
  });
  cleanup.push(() => call('DELETE', `${API}/alert/${secondAlert.id}`).catch(() => undefined));
  const result = await call('POST', `${API}/alert/${secondAlert.id}/merge/${caseItem.id}`, {});
  assert((result.id || result._id) === caseItem.id, `merged case=${JSON.stringify(result).slice(0, 250)}`);
  return `merged into ${caseItem.id}`;
});

await test('get case and search cases by caseId', async () => {
  const detail = await call('GET', `${API}/case/${caseItem.id}`);
  assert(detail._type === 'case' && detail.caseId === caseItem.caseId, JSON.stringify(detail).slice(0, 200));
  assert(Array.isArray(detail.tasks) && Array.isArray(detail.artifacts), 'tasks/artifacts missing');
  const found = await call('POST', `${API}/case/_search`, {
    query: { _field: 'caseId', _value: caseItem.caseId },
    range: '0-10',
    sort: '-createdAt',
  });
  assert(Array.isArray(found) && found.some((item) => item.id === caseItem.id), `case not found: ${JSON.stringify(found).slice(0, 300)}`);
  return `#${caseItem.caseId}`;
});

await test('list case links', async () => {
  const result = await call('GET', `${API}/case/${caseItem.id}/links`);
  assert(Array.isArray(result), `links=${JSON.stringify(result).slice(0, 200)}`);
  for (const item of result) assert(Array.isArray(item.linkedWith), 'linkedWith is not an array');
  return `${result.length} linked case(s)`;
});

let urlArtifact;
await test('add JSON artifact to case', async () => {
  urlArtifact = await call('POST', `${API}/case/${caseItem.id}/artifact`, {
    dataType: 'url',
    data: `https://${stamp}.example/login`,
    message: 'Phishing URL',
    tlp: 2,
    pap: 2,
    ioc: true,
    tags: ['phishing'],
  });
  cleanup.push(() => call('DELETE', `${API}/case/artifact/${urlArtifact.id}`).catch(() => undefined));
  assert(urlArtifact._type === 'case_artifact' && urlArtifact.dataType === 'url', JSON.stringify(urlArtifact).slice(0, 200));
  return urlArtifact.data;
});

let fileArtifact;
await test('add file artifact to case via multipart', async () => {
  const filename = `sample-${stamp}.txt`;
  const form = new FormData();
  form.append('_json', JSON.stringify({ dataType: 'file', message: 'Uploaded sample', tlp: 2, pap: 2 }));
  form.append('attachment', new Blob([`file ${stamp}`], { type: 'text/plain' }), filename);
  fileArtifact = await call('POST', `${API}/case/${caseItem.id}/artifact`, form);
  cleanup.push(() => call('DELETE', `${API}/case/artifact/${fileArtifact.id}`).catch(() => undefined));
  if (fileArtifact.attachment?._id) {
    const attachmentId = fileArtifact.attachment._id;
    cleanup.push(() => call('DELETE', `${V1}/case/${caseItem.id}/attachment/${attachmentId}`).catch(() => undefined));
  }
  assert(fileArtifact._type === 'case_artifact', JSON.stringify(fileArtifact).slice(0, 200));
  assert(fileArtifact.dataType === 'file', `dataType=${fileArtifact.dataType}`);
  assert(fileArtifact.data === filename, `data=${fileArtifact.data}`);
  assert(fileArtifact.attachment?._id, 'attachment was not stored');
  return `${fileArtifact.id} · ${filename}`;
});

await test('search artifacts with _parent case query', async () => {
  const result = await call('POST', `${API}/case/artifact/_search`, {
    query: { _parent: { _type: 'case', _query: { _id: caseItem.id } } },
    range: '0-100',
    sort: '-createdAt',
  });
  assert(Array.isArray(result), `result=${JSON.stringify(result).slice(0, 200)}`);
  assert(result.some((item) => item.id === urlArtifact.id), 'url artifact missing');
  assert(result.some((item) => item.id === fileArtifact.id), 'file artifact missing');
  assert(result.every((item) => item._type === 'case_artifact'), 'wrong _type in artifact search');
  return `${result.length} artifact(s)`;
});

let task;
await test('create task', async () => {
  task = await call('POST', `${API}/case/${caseItem.id}/task`, {
    title: `Contain ${stamp}`,
    description: 'Block the source host',
    group: 'Containment',
    status: 'Waiting',
    flag: true,
  });
  assert(task._type === 'case_task', JSON.stringify(task).slice(0, 200));
  assert(task.status === 'Waiting', `status=${task.status}`);
  return task.id;
});

await test('update task status', async () => {
  const result = await call('PATCH', `${API}/case/task/${task.id}`, { status: 'InProgress' });
  assert(result.status === 'InProgress', `status=${result.status}`);
  return result.status;
});

let jsonLog;
await test('add task log (JSON)', async () => {
  jsonLog = await call('POST', `${API}/case/task/${task.id}/log`, {
    message: `Log JSON ${stamp}`,
  });
  assert(jsonLog._type === 'case_task_log', JSON.stringify(jsonLog).slice(0, 200));
  assert(typeof jsonLog.date === 'number', `date=${jsonLog.date}`);
  return jsonLog.id;
});

let multipartLog;
await test('add task log (multipart with attachment)', async () => {
  const form = new FormData();
  form.append('message', `Log multipart ${stamp}`);
  form.append('attachment', new Blob([`log attachment ${stamp}`], { type: 'text/plain' }), `log-${stamp}.txt`);
  multipartLog = await call('POST', `${API}/case/task/${task.id}/log`, form);
  if (multipartLog.attachments?.[0]?._id) {
    const attachmentId = multipartLog.attachments[0]._id;
    cleanup.push(() => call('DELETE', `${V1}/log/${multipartLog.id}/attachments/${attachmentId}`).catch(() => undefined));
  }
  assert(multipartLog._type === 'case_task_log', JSON.stringify(multipartLog).slice(0, 200));
  assert(multipartLog.message.includes('Log multipart'), `message=${multipartLog.message}`);
  assert(Array.isArray(multipartLog.attachments) && multipartLog.attachments.length === 1, `attachments=${JSON.stringify(multipartLog.attachments)}`);
  return `${multipartLog.id} · 1 attachment`;
});

await test('get task logs and search logs with _parent task query', async () => {
  const list = await call('GET', `${API}/case/task/${task.id}/log`);
  assert(Array.isArray(list) && list.some((item) => item.id === jsonLog.id) && list.some((item) => item.id === multipartLog.id), `logs=${JSON.stringify(list).slice(0, 300)}`);
  const found = await call('POST', `${API}/case/task/log/_search`, {
    query: { _parent: { _type: 'case_task', _query: { _id: task.id } } },
    range: '0-100',
    sort: '-date',
  });
  assert(Array.isArray(found) && found.some((item) => item.id === jsonLog.id), `log not found: ${JSON.stringify(found).slice(0, 300)}`);
  assert(found.every((item) => item._type === 'case_task_log'), 'wrong _type in log search');
  return `${found.length} log(s)`;
});

await test('search case templates', async () => {
  const result = await call('POST', `${API}/case/template/_search`, { query: {}, range: '0-100', sort: '-createdAt' });
  assert(Array.isArray(result), `templates=${JSON.stringify(result).slice(0, 200)}`);
  for (const template of result) {
    assert(template._type === 'caseTemplate', `template _type=${template._type}`);
    assert(template.id === template._id, 'template id/_id mismatch');
  }
  return `${result.length} template(s)`;
});

await test('close case (Resolved) and verify status', async () => {
  const closed = await call('PATCH', `${API}/case/${caseItem.id}`, {
    status: 'Resolved',
    resolutionStatus: 'TruePositive',
    impactStatus: 'Indirect',
    summary: `Summary ${stamp}`,
  });
  assert(closed.status === 'Resolved', `status=${closed.status}`);
  const detail = await call('GET', `${API}/case/${caseItem.id}`);
  assert(detail.status === 'Resolved', `status=${detail.status}`);
  assert(detail.summary === `Summary ${stamp}`, `summary=${detail.summary}`);
  assert(typeof detail.endDate === 'number', `endDate=${detail.endDate}`);
  return `#${detail.caseId} Resolved`;
});

await test('X-Organisation known org is accepted', async () => {
  const result = await call('GET', `${API}/user/current`, undefined, { headers: { 'X-Organisation': organisation } });
  assert(result.login === me.login, `login=${result.login}`);
  return organisation;
});

await test('X-Organisation bogus org is rejected with 403', async () => {
  await call('GET', `${API}/user/current`, undefined, { headers: { 'X-Organisation': `bogus-${stamp}` }, expect: 403 });
  return '403';
});

for (const fn of cleanup.reverse()) await fn();

console.log(`\n${passed} PASS · ${failed} FAIL`);
process.exit(failed ? 1 : 0);
