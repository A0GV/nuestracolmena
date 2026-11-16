#!/usr/bin/env node
// End-to-end compatibility test: replays the exact requests the n8n "TheHive 5"
// node sends against MyHive. It creates its own objects and deletes them at the end.
//   MYHIVE_URL=http://127.0.0.1:4100 MYHIVE_LOGIN=admin@myhive.local MYHIVE_PASSWORD=... node scripts/thehive5-compat-test.mjs

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
  if (token) headers.Authorization = `Bearer ${token}`;
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

async function raw(method, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: options.body });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${buffer.toString('utf8').slice(0, 400)}`);
  return { status: res.status, headers: res.headers, buffer, text: buffer.toString('utf8') };
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

function query(name, idOrName) {
  return idOrName === undefined ? { _name: name } : { _name: name, idOrName };
}

console.log(`MyHive TheHive 5 compatibility test → ${ORIGIN}\n`);

let me;
await test('login', async () => {
  const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD });
  token = result.token;
  me = result.user;
  assert(token, 'no token');
  return me.login;
});

let alert;
let alertObservable;
const alertSourceRef = `n8n-compat-${stamp}`;
await test('create alert with observables (including data arrays)', async () => {
  alert = await call('POST', `${V1}/alert`, {
    title: `n8n compat alert ${stamp}`,
    description: 'Created by the TheHive 5 compatibility test',
    type: 'n8n-compat',
    source: 'thehive5-compat-test',
    sourceRef: alertSourceRef,
    severity: 3,
    tlp: 2,
    pap: 2,
    status: 'New',
    date: Date.now(),
    tags: ['compat', 'n8n'],
    observables: [
      { dataType: 'ip', data: `198.51.100.${(Date.now() % 200) + 10}`, message: 'IP observable', tags: ['net'] },
      { dataType: 'domain', data: [`a-${stamp}.example`, `b-${stamp}.example`], message: 'Two domains', tags: ['dns'] },
    ],
    customFields: [{ name: 'business-impact', value: 'High' }],
  });
  cleanup.push(() => call('DELETE', `${V1}/alert/${alert._id}`).catch(() => undefined));
  assert(alert._id && alert._type === 'Alert', `unexpected alert: ${JSON.stringify(alert).slice(0, 200)}`);
  assert(typeof alert.date === 'number' && alert.date > 0, `date is not epoch ms: ${alert.date}`);
  assert(alert.status === 'New', `status=${alert.status}`);
  assert(alert.observables.length === 3, `observables=${alert.observables.length}`);
  assert(alert.customFields['business-impact'] === 'High', JSON.stringify(alert.customFields));
  assert(alert.tags.includes('n8n'), JSON.stringify(alert.tags));
  alertObservable = alert.observables.find((item) => item.dataType === 'ip');
  return `${alert._id} · ${alert.observables.length} observables`;
});

await test('get alert (REST)', async () => {
  const result = await call('GET', `${V1}/alert/${alert._id}`);
  assert(result._id === alert._id && result._type === 'Alert', JSON.stringify(result).slice(0, 200));
  assert(result.observables.length === 3, 'observables missing');
  return result.title;
});

await test('get alert (query API)', async () => {
  const result = await call('POST', `${V1}/query`, { query: [query('getAlert', alert._id)] });
  assert(Array.isArray(result) && result.length === 1, `expected an array of one, got ${JSON.stringify(result).slice(0, 200)}`);
  assert(result[0]._id === alert._id && result[0]._type === 'Alert', 'wrong alert');
  return result[0]._id;
});

await test('search alerts with filter + sort + page', async () => {
  const result = await call('POST', `${V1}/query`, {
    query: [
      { _name: 'listAlert' },
      {
        _name: 'filter',
        _and: [
          { _eq: { _field: 'sourceRef', _value: alertSourceRef } },
          { _like: { _field: 'title', _value: '*compat*' } },
          { _in: { _field: 'severity', _values: ['3'] } },
        ],
      },
      { _name: 'sort', _fields: [{ date: 'desc' }] },
      { _name: 'page', from: 0, to: 10, extraData: ['caseNumber'] },
    ],
  });
  assert(Array.isArray(result) && result.some((item) => item._id === alert._id), `alert not found: ${JSON.stringify(result).slice(0, 300)}`);
  return `${result.length} result(s)`;
});

await test('count alerts', async () => {
  const count = await call('POST', `${V1}/query`, {
    query: [
      { _name: 'listAlert' },
      { _name: 'filter', _and: [{ _eq: { _field: 'sourceRef', _value: alertSourceRef } }] },
      { _name: 'count' },
    ],
  });
  assert(typeof count === 'number' && count >= 1, `count=${JSON.stringify(count)}`);
  return String(count);
});

await test('update alert', async () => {
  const result = await call('PATCH', `${V1}/alert/${alert._id}`, { severity: 4, status: 'InProgress', addTags: ['updated'] });
  assert(result.severity === 4, `severity=${result.severity}`);
  assert(result.status === 'InProgress', `status=${result.status}`);
  assert(result.tags.includes('updated'), JSON.stringify(result.tags));
  return `severity=${result.severity}`;
});

await test('add observable to alert', async () => {
  const result = await call('POST', `${V1}/alert/${alert._id}/observable`, {
    dataType: 'url',
    data: `https://${stamp}.example/login`,
    message: 'Added by n8n',
    tags: ['added'],
  });
  cleanup.push(() => call('DELETE', `${V1}/observable/${result._id}`).catch(() => undefined));
  assert(result._id && result._type === 'Observable', JSON.stringify(result).slice(0, 200));
  assert(result.dataType === 'url' && result.data.includes(stamp), 'wrong observable');
  alertObservable = result;
  return result.data;
});

let caseItem;
await test('promote alert to case', async () => {
  caseItem = await call('POST', `${V1}/alert/${alert._id}/case`, {});
  cleanup.push(() => call('DELETE', `${V1}/case/${caseItem._id}`).catch(() => undefined));
  assert(caseItem._id && caseItem._type === 'Case', JSON.stringify(caseItem).slice(0, 250));
  assert(typeof caseItem.number === 'number', `number=${caseItem.number}`);
  assert(caseItem.observables.some((item) => item.dataType === 'url'), 'alert observables were not moved to the case');
  return `#${caseItem.number}`;
});

let secondAlert;
await test('merge a second alert into the case (absolute /api/alert route)', async () => {
  secondAlert = await call('POST', `${V1}/alert`, {
    title: `n8n compat merge ${stamp}`,
    type: 'n8n-compat',
    source: 'thehive5-compat-test',
    sourceRef: `merge-${stamp}`,
    severity: 2,
    tlp: 2,
    pap: 2,
    date: Date.now(),
    tags: ['merge'],
  });
  cleanup.push(() => call('DELETE', `${V1}/alert/${secondAlert._id}`).catch(() => undefined));
  const result = await call('POST', `${API}/alert/${secondAlert._id}/merge/${caseItem._id}`, {});
  assert(result._id === caseItem._id && result._type === 'Case', JSON.stringify(result).slice(0, 250));
  return result._id;
});

await test('get case by id and by number (query API)', async () => {
  const byId = await call('POST', `${V1}/query`, { query: [query('getCase', caseItem._id)] });
  assert(Array.isArray(byId) && byId.length === 1 && byId[0]._id === caseItem._id, 'not found by id');
  const byNumber = await call('POST', `${V1}/query`, { query: [query('getCase', String(caseItem.number))] });
  assert(Array.isArray(byNumber) && byNumber.length === 1 && byNumber[0]._id === caseItem._id, 'not found by number');
  const rest = await call('GET', `${V1}/case/${caseItem._id}`);
  assert(rest._id === caseItem._id && rest._type === 'Case', 'REST get failed');
  return `#${byNumber[0].number}`;
});

await test('update case', async () => {
  const result = await call('PATCH', `${V1}/case/${caseItem._id}`, {
    severity: 2,
    addTags: ['case-updated'],
    customFields: [{ name: 'detection-source', value: 'SIEM' }],
  });
  assert(result.severity === 2, `severity=${result.severity}`);
  assert(result.tags.includes('case-updated'), JSON.stringify(result.tags));
  assert(result.customFields['detection-source'] === 'SIEM', JSON.stringify(result.customFields));
  return `severity=${result.severity}`;
});

let task;
await test('add task to case', async () => {
  task = await call('POST', `${V1}/case/${caseItem._id}/task`, {
    title: 'Contain host',
    description: 'Block the host at the firewall',
    group: 'Containment',
    status: 'Waiting',
    flag: true,
    dueDate: Date.now() + 86400000,
  });
  cleanup.push(() => call('DELETE', `${V1}/task/${task._id}`).catch(() => undefined));
  assert(task._id && task._type === 'Task', JSON.stringify(task).slice(0, 200));
  assert(typeof task.dueDate === 'number', `dueDate=${task.dueDate}`);
  return task._id;
});

let log;
await test('add log to task', async () => {
  log = await call('POST', `${V1}/task/${task._id}/log`, {
    message: 'Log added by the n8n compatibility test',
    startDate: Date.now(),
    includeInTimeline: true,
  });
  cleanup.push(() => call('DELETE', `${V1}/log/${log._id}`).catch(() => undefined));
  assert(log._id && log._type === 'Log', JSON.stringify(log).slice(0, 200));
  assert(typeof log.date === 'number', `date=${log.date}`);
  return log._id;
});

await test('search tasks of the case via query traversal', async () => {
  const result = await call('POST', `${V1}/query`, {
    query: [
      query('getCase', caseItem._id),
      { _name: 'tasks' },
      { _name: 'filter', _and: [{ _eq: { _field: 'title', _value: 'Contain host' } }] },
      { _name: 'page', from: 0, to: 10, extraData: ['case'] },
    ],
  });
  assert(Array.isArray(result) && result.some((item) => item._id === task._id), `task not found: ${JSON.stringify(result).slice(0, 300)}`);
  return `${result.length} task(s)`;
});

await test('search observables of the case via query traversal', async () => {
  const result = await call('POST', `${V1}/query`, {
    query: [
      query('getCase', caseItem._id),
      { _name: 'observables' },
      { _name: 'sort', _fields: [{ createdAt: 'desc' }] },
      { _name: 'page', from: 0, to: 50, extraData: ['seen'] },
    ],
  });
  assert(Array.isArray(result), 'observables is not an array');
  assert(result.some((item) => item.dataType === 'ip'), 'IP observable missing');
  assert(result.some((item) => item.dataType === 'domain'), 'domain observable missing');
  return `${result.length} observable(s)`;
});

await test('search logs of the case via query traversal', async () => {
  const result = await call('POST', `${V1}/query`, {
    query: [
      query('getCase', caseItem._id),
      { _name: 'logs' },
      { _name: 'page', from: 0, to: 10, extraData: ['task', 'case'] },
    ],
  });
  assert(Array.isArray(result) && result.some((item) => item._id === log._id), `log not found: ${JSON.stringify(result).slice(0, 300)}`);
  return `${result.length} log(s)`;
});

await test('get task / observable / log via query API', async () => {
  const taskResult = await call('POST', `${V1}/query`, { query: [query('getTask', task._id)] });
  assert(Array.isArray(taskResult) && taskResult[0]?._id === task._id, 'task not found');
  const observableResult = await call('POST', `${V1}/query`, { query: [query('getObservable', alertObservable._id)] });
  assert(Array.isArray(observableResult) && observableResult[0]?._id === alertObservable._id, 'observable not found');
  const logResult = await call('POST', `${V1}/query`, { query: [query('getLog', log._id)] });
  assert(Array.isArray(logResult) && logResult[0]?._id === log._id, 'log not found');
  assert(Array.isArray(logResult[0].attachments), 'log attachments missing');
  return 'all get* starters';
});

let comment;
await test('add comment to case', async () => {
  comment = await call('POST', `${V1}/case/${caseItem._id}/comment`, { message: `comment ${stamp}` });
  assert(comment._id && comment._type === 'Comment', JSON.stringify(comment).slice(0, 200));
  return comment._id;
});

await test('update and delete comment', async () => {
  const updated = await call('PATCH', `${V1}/comment/${comment._id}`, { message: `updated comment ${stamp}` });
  assert(updated.message.includes('updated comment'), `message=${updated.message}`);
  await call('DELETE', `${V1}/comment/${comment._id}`);
  const found = await call('POST', `${V1}/query`, { query: [query('getComment', comment._id)] }).catch((error) => {
    if (String(error.message).includes('404')) return null;
    throw error;
  });
  assert(found === null, 'deleted comment still exists');
  return 'updated + deleted';
});

await test('get case timeline', async () => {
  const result = await call('GET', `${V1}/case/${caseItem._id}/timeline`);
  assert(result && Array.isArray(result.events), `timeline=${JSON.stringify(result).slice(0, 200)}`);
  assert(result.events.length > 0, 'timeline is empty');
  for (const event of result.events) {
    assert(typeof event.date === 'number' && event.kind && event.entity && event.entityId, `bad event ${JSON.stringify(event)}`);
  }
  assert(result.events.some((event) => event.kind === 'task-log'), 'task log missing from timeline');
  assert(result.events.some((event) => event.kind === 'observable-created'), 'observable missing from timeline');
  for (let i = 1; i < result.events.length; i++) assert(result.events[i - 1].date >= result.events[i].date, 'timeline is not newest first');
  return `${result.events.length} events`;
});

let attachmentId;
await test('upload, download and delete a case attachment', async () => {
  const form = new FormData();
  form.append('attachments', new Blob([`attachment ${stamp}`], { type: 'text/plain' }), `compat-${stamp}.txt`);
  form.append('canRename', 'true');
  const uploaded = await call('POST', `${V1}/case/${caseItem._id}/attachments`, form);
  const list = Array.isArray(uploaded) ? uploaded : [uploaded];
  assert(list.length === 1 && list[0]._id, `upload=${JSON.stringify(uploaded).slice(0, 200)}`);
  attachmentId = list[0]._id;
  const downloaded = await raw('GET', `${V1}/case/${caseItem._id}/attachment/${attachmentId}/download`);
  assert(downloaded.text === `attachment ${stamp}`, `download=${downloaded.text}`);
  await call('DELETE', `${V1}/case/${caseItem._id}/attachment/${attachmentId}`);
  return `${attachmentId} · ${downloaded.buffer.length} bytes`;
});

let page;
await test('create, update and delete a case page (caseId column)', async () => {
  page = await call('POST', `${V1}/case/${caseItem._id}/page`, {
    title: `Page ${stamp}`,
    category: 'Investigation',
    content: 'Initial page content',
  });
  assert(page._id && page._type === 'Page', JSON.stringify(page).slice(0, 200));
  assert(page.caseId === caseItem._id, `caseId=${page.caseId}`);
  assert(page.category === 'Investigation', `category=${page.category}`);
  const pages = await call('POST', `${V1}/query`, { query: [query('getCase', caseItem._id), { _name: 'pages' }] });
  assert(Array.isArray(pages) && pages.some((item) => item._id === page._id), 'case page missing from traversal');
  assert(pages.every((item) => item.caseId === caseItem._id), 'case page has no caseId');
  const kb = await call('POST', `${V1}/query`, { query: [{ _name: 'listOrganisationPage' }, { _name: 'page', from: 0, to: 100 }] });
  const listPage = await call('POST', `${V1}/query`, { query: [{ _name: 'listPage' }, { _name: 'page', from: 0, to: 100 }] });
  const adminPages = await call('GET', `${V1}/pages`);
  assert(!kb.some((item) => item._id === page._id), 'case page leaked into listOrganisationPage');
  assert(!listPage.some((item) => item._id === page._id), 'case page leaked into listPage');
  assert(!adminPages.some((item) => item._id === page._id), 'case page leaked into admin pages');
  const updated = await call('PATCH', `${V1}/case/${caseItem._id}/page/${page._id}`, { content: 'Updated content', title: `Updated ${stamp}` });
  assert(updated.content === 'Updated content', `content=${updated.content}`);
  assert(updated.caseId === caseItem._id, `updated caseId=${updated.caseId}`);
  await call('DELETE', `${V1}/case/${caseItem._id}/page/${page._id}`);
  return page._id;
});

await test('list custom fields (absolute /api/customField)', async () => {
  const fields = await call('GET', `${API}/customField`);
  assert(Array.isArray(fields), `customFields=${JSON.stringify(fields).slice(0, 200)}`);
  if (fields.length) {
    assert(fields[0]._type === 'CustomField', 'wrong _type');
    assert(fields[0].reference && fields[0].name && fields[0].type !== undefined, `bad field ${JSON.stringify(fields[0])}`);
  }
  return `${fields.length} field(s)`;
});

let cortexConnector;
await test('list Cortex analyzers by data type', async () => {
  const connectors = await call('GET', `${V1}/connectors`);
  cortexConnector = Array.isArray(connectors) ? connectors.find((connector) => connector.type === 'cortex') : null;
  if (!cortexConnector) return 'SKIP: no Cortex connector';
  const analyzers = await call('GET', `${API}/connector/cortex/analyzer/type/ip`);
  assert(Array.isArray(analyzers), `analyzers=${JSON.stringify(analyzers).slice(0, 200)}`);
  if (analyzers.length) {
    const analyzer = analyzers[0];
    assert(analyzer.id && analyzer.name && Array.isArray(analyzer.cortexIds) && analyzer.cortexIds.length === 1, `bad analyzer ${JSON.stringify(analyzer)}`);
  }
  return `${analyzers.length} analyzer(s)`;
});

await test('start Cortex analyzer by name (analyzerId resolved to Cortex id)', async () => {
  if (!cortexConnector) return 'SKIP: no Cortex connector';
  const analyzers = await call('GET', `${API}/connector/cortex/analyzer/type/ip`);
  const analyzer = analyzers.find((item) => item.name === 'TorProject_1_0') || analyzers.find((item) => item.name.startsWith('TorProject')) || analyzers[0];
  if (!analyzer) return 'SKIP: no analyzer for dataType ip';
  const caseDetail = await call('GET', `${V1}/case/${caseItem._id}`);
  const ipObservable = (caseDetail.observables || []).find((item) => item.dataType === 'ip');
  assert(ipObservable, 'no ip observable in the case');
  const job = await call('POST', `${API}/connector/cortex/job`, {
    analyzerId: analyzer.name,
    cortexId: cortexConnector.id,
    artifactId: ipObservable._id,
  });
  assert(job.id && job._id, `no job id: ${JSON.stringify(job).slice(0, 300)}`);
  assert(job.analyzerId === analyzer.id, `analyzerId=${job.analyzerId} expected Cortex id ${analyzer.id}`);
  assert(job.analyzerName, 'analyzerName is missing');
  assert(job.cortexId === cortexConnector.id, `cortexId=${job.cortexId}`);
  return `${analyzer.name} → ${analyzer.id}`;
});

await test('run Cortex responder by name and expose action names', async () => {
  if (!cortexConnector) return 'SKIP: no Cortex connector';
  const responders = await call('GET', `${API}/connector/cortex/responder/case/${caseItem._id}`);
  const responder = responders.find((item) => item.name === 'DevTools_Echo_Responder_1_0') || responders.find((item) => item.name.startsWith('DevTools_Echo'));
  if (!responder) return 'SKIP: DevTools_Echo responder not enabled';
  const action = await call('POST', `${API}/connector/cortex/action`, {
    responderId: responder.name,
    objectType: 'case',
    objectId: caseItem._id,
    cortexId: cortexConnector.id,
  });
  assert(action._id && action.status, `bad action: ${JSON.stringify(action).slice(0, 300)}`);
  assert(action.responderId === responder.id, `responderId=${action.responderId} expected Cortex id ${responder.id}`);
  assert(action.responderName === responder.name, `responderName=${action.responderName} expected ${responder.name}`);
  assert(action.objectId === caseItem._id, `objectId=${action.objectId}`);
  assert(typeof action.startDate === 'number', `startDate=${action.startDate}`);
  const found = await call('POST', `${V1}/query`, {
    query: [
      { _name: 'listAction' },
      {
        _name: 'filter',
        _and: [
          { _eq: { _field: 'cortexId', _value: action.cortexId } },
          { _eq: { _field: 'objectId', _value: action.objectId } },
          { _eq: { _field: 'startDate', _value: action.startDate } },
        ],
      },
    ],
  });
  assert(found && found._id === action._id, `listAction did not return the action: ${JSON.stringify(found).slice(0, 300)}`);
  assert(found.responderId === responder.id, `listAction responderId=${found.responderId}`);
  assert(found.responderName === responder.name, `listAction responderName=${found.responderName} expected ${responder.name}`);
  return `${responder.name} → ${responder.id}`;
});

// ------------------------------------------------------------------ cleanup
for (const fn of cleanup.reverse()) await fn();

console.log(`\n${passed} PASS · ${failed} FAIL`);
process.exit(failed ? 1 : 0);
