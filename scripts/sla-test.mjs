#!/usr/bin/env node
// End-to-end test of the MyHive SLA rules, scheduler events and notifications.
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/sla-test.mjs
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
const received = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(method, url, body, options = {}) {
  const headers = { ...(options.headers || {}) };
  let payload;
  if (body !== undefined) {
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

async function waitFor(fn, { timeoutMs = 12000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let parsed = body;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      // keep raw text
    }
    received.push({ path: req.url, method: req.method, body: parsed, at: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

console.log(`MyHive SLA test → ${ORIGIN}\n`);

const httpPort = await listen(receiver);
console.log(`Local receiver http://127.0.0.1:${httpPort}\n`);

const created = { rules: [], cases: [], alerts: [], notifications: [], endpoints: [] };
const tag = `sla-test-${stamp}`;
const alertType = `sla-test-${stamp}`;

try {
  await test('login', async () => {
    const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD });
    token = result.token;
    assert(token, 'no token');
    return result.user?.login;
  });

  await test('reject an invalid rule config with a clear 400', async () => {
    const result = await call('POST', `${V1}/sla-rules`, { name: `invalid-${stamp}`, config: { appliesTo: 'case', objectives: {} } }, { expect: 400 });
    assert(String(result?.message || '').length > 0, 'missing error message');
    return result.message;
  });

  let caseRule;
  let alertRule;
  await test('create SLA rules (high severity cases, alert type)', async () => {
    caseRule = await call('POST', `${V1}/sla-rules`, {
      name: `high-severity-cases-${stamp}`,
      enabled: true,
      order: 0,
      config: {
        appliesTo: 'case',
        match: { severityIn: [4], tagsAny: [tag] },
        objectives: { acknowledgeMinutes: 1, resolveMinutes: 2 },
        warnPercent: 80,
        businessHours: false,
      },
    });
    created.rules.push(caseRule.id);
    alertRule = await call('POST', `${V1}/sla-rules`, {
      name: `alerts-${stamp}`,
      enabled: true,
      order: 0,
      config: {
        appliesTo: 'alert',
        match: { alertTypeIn: [alertType] },
        objectives: { acknowledgeMinutes: 1, resolveMinutes: 1 },
        warnPercent: 80,
        businessHours: false,
      },
    });
    created.rules.push(alertRule.id);
    assert(caseRule.id && alertRule.id, 'rule ids missing');
    return `${caseRule.name}, ${alertRule.name}`;
  });

  let matchingCase;
  let nonMatchingCase;
  await test('matching case gets sla and a default dueDate', async () => {
    matchingCase = await call('POST', `${V1}/cases`, {
      title: `SLA matching case ${stamp}`,
      description: 'SLA test',
      severity: 4,
      tags: [tag],
    });
    created.cases.push(matchingCase.id);
    assert(matchingCase.sla, 'case has no sla');
    assert(matchingCase.sla.ruleId === caseRule.id, `unexpected rule ${matchingCase.sla.ruleId}`);
    assert(matchingCase.sla.acknowledge?.state === 'ok', `ack state ${matchingCase.sla.acknowledge?.state}`);
    assert(matchingCase.sla.resolve?.state === 'ok', `resolve state ${matchingCase.sla.resolve?.state}`);
    assert(matchingCase.dueDate, 'dueDate was not set from the rule');
    return `due ${matchingCase.dueDate}`;
  });

  await test('non-matching case has no sla', async () => {
    nonMatchingCase = await call('POST', `${V1}/cases`, {
      title: `SLA non matching case ${stamp}`,
      description: 'SLA test',
      severity: 1,
      tags: [`other-${stamp}`],
    });
    created.cases.push(nonMatchingCase.id);
    assert(!nonMatchingCase.sla, `unexpected sla ${JSON.stringify(nonMatchingCase.sla)}`);
    assert(!nonMatchingCase.dueDate, `unexpected dueDate ${nonMatchingCase.dueDate}`);
    return 'no sla';
  });

  await test('moving the case to InProgress marks the acknowledge objective as met', async () => {
    await call('PATCH', `${V1}/cases/${matchingCase.id}`, { status: 'InProgress' });
    const detail = await call('GET', `${V1}/cases/${matchingCase.id}`);
    assert(detail.sla?.acknowledge, 'acknowledge objective missing');
    assert(detail.sla.acknowledge.state === 'met', `ack state ${detail.sla.acknowledge.state}`);
    assert(detail.sla.acknowledge.metAt, 'acknowledge metAt missing');
    return detail.sla.acknowledge.metAt;
  });

  let matchingAlert;
  await test('alert rule matches alerts of its type', async () => {
    matchingAlert = await call('POST', `${V1}/alerts`, {
      title: `SLA alert ${stamp}`,
      description: 'SLA test alert',
      type: alertType,
      source: 'sla-test',
      sourceRef: `sla-${stamp}`,
      severity: 2,
      tags: [tag],
    });
    created.alerts.push(matchingAlert.id);
    const detail = await call('GET', `${V1}/alerts/${matchingAlert.id}`);
    assert(detail.sla, 'alert has no sla');
    assert(detail.sla.ruleId === alertRule.id, `unexpected rule ${detail.sla.ruleId}`);
    assert(detail.sla.acknowledge?.state === 'ok', `ack state ${detail.sla.acknowledge?.state}`);
    assert(detail.sla.resolve?.state === 'ok', `resolve state ${detail.sla.resolve?.state}`);
    return detail.sla.ruleName;
  });

  let endpoint;
  await test('create a webhook endpoint and a SlaBreached notification', async () => {
    endpoint = await call('POST', `${V1}/endpoints`, {
      name: `sla-webhook-${stamp}`,
      type: 'webhook',
      config: { url: `http://127.0.0.1:${httpPort}/sla`, method: 'POST', format: 'thehive', auth: { type: 'none' } },
    });
    created.endpoints.push(endpoint.id);
    const notification = await call('POST', `${V1}/notifications`, {
      name: `SLA breached ${stamp}`,
      enabled: true,
      config: {
        trigger: 'SlaBreached',
        filter: { objectType: 'Alert' },
        notifiers: [{ type: 'webhook', endpointId: endpoint.id }],
      },
    });
    created.notifications.push(notification.id);
    assert(notification.id, 'notification id missing');
    return notification.name;
  });

  await test('preview reports matching open objects', async () => {
    const casePreview = await call('POST', `${V1}/sla-rules/${caseRule.id}/preview`);
    assert(casePreview.count >= 1, `case preview count ${casePreview.count}`);
    assert(casePreview.items.some((item) => item.objectId === matchingCase.id), 'matching case missing from preview');
    const alertPreview = await call('POST', `${V1}/sla-rules/${alertRule.id}/preview`);
    assert(alertPreview.count >= 1, `alert preview count ${alertPreview.count}`);
    return `case ${casePreview.count}, alert ${alertPreview.count}`;
  });

  await test('wait for the alert deadline and let the scheduler emit SlaBreached', async () => {
    console.log('     waiting 70s for the 1 minute objectives to breach…');
    await sleep(70000);
    const detail = await call('GET', `${V1}/alerts/${matchingAlert.id}`);
    assert(detail.sla.resolve?.state === 'breached', `resolve state ${detail.sla.resolve?.state}`);
    const result = await call('POST', `${V1}/sla/evaluate-now`);
    assert(result && typeof result.emitted === 'number', 'evaluate-now response missing emitted count');
    const event = await waitFor(() =>
      received.find((entry) => entry.path === '/sla'
        && entry.body?.objectType === 'Alert'
        && entry.body?.action === 'update'
        && entry.body?.details?.sla?.kind === 'breach'),
    );
    assert(event.body.details.sla.objective === 'acknowledge' || event.body.details.sla.objective === 'resolve', `unexpected objective ${event.body.details.sla.objective}`);
    assert(event.body.details.sla.rule?.name === alertRule.name, `unexpected rule ${event.body.details.sla.rule?.name}`);
    return `emitted now ${result.emitted}`;
  });

  await test('summary reports per-rule counts and compliance', async () => {
    const summary = await call('GET', `${V1}/sla/summary`);
    const caseRow = (summary.rules || []).find((row) => row.ruleId === caseRule.id);
    const alertRow = (summary.rules || []).find((row) => row.ruleId === alertRule.id);
    assert(caseRow, 'case rule missing from summary');
    assert(alertRow, 'alert rule missing from summary');
    assert(caseRow.objectives.acknowledge.total >= 1, `case ack total ${caseRow.objectives.acknowledge.total}`);
    assert(caseRow.objectives.acknowledge.metOnTime >= 1, `case ack met ${caseRow.objectives.acknowledge.metOnTime}`);
    assert(alertRow.objectives.resolve.total >= 1, `alert resolve total ${alertRow.objectives.resolve.total}`);
    assert(alertRow.objectives.resolve.breachedOpen >= 1, `alert breached ${alertRow.objectives.resolve.breachedOpen}`);
    assert(typeof alertRow.objectives.resolve.compliance === 'number', 'compliance missing');
    return `alert compliance ${alertRow.objectives.resolve.compliance}%`;
  });
} catch (error) {
  failed++;
  console.log(`FAIL (fatal)\n     ${error.stack || error.message}`);
} finally {
  try {
    for (const id of created.notifications) await call('DELETE', `${V1}/notifications/${id}`).catch(() => undefined);
    for (const id of created.endpoints) await call('DELETE', `${V1}/endpoints/${id}`).catch(() => undefined);
    for (const id of created.alerts) await call('DELETE', `${V1}/alerts/${id}`).catch(() => undefined);
    for (const id of created.cases) await call('DELETE', `${V1}/cases/${id}?force=true`).catch(() => undefined);
    for (const id of created.rules) await call('DELETE', `${V1}/sla-rules/${id}`).catch(() => undefined);
    receiver.close();
  } catch { /* ignore */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
