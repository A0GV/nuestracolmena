#!/usr/bin/env node
// End-to-end test of the MyHive event bus + notification engine.
// Starts a local HTTP receiver and a fake SMTP server, creates its own endpoints,
// notifications, alert and case, then deletes everything it created.
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/notifications-test.mjs

import http from 'node:http';
import net from 'node:net';

const ORIGIN = (process.env.MYHIVE_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const V1 = `${ORIGIN}/api/v1`;
const LOGIN = process.env.MYHIVE_LOGIN || 'admin@myhive.local';
const PASSWORD = process.env.MYHIVE_PASSWORD || 'admin123';
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let token = '';
let passed = 0;
let failed = 0;
const cleanup = [];
const received = [];
const smtpMessages = [];

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

async function waitFor(fn, { timeoutMs = 8000, everyMs = 200 } = {}) {
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

// ---------------------------------------------------------------- local servers

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
    received.push({ path: req.url, method: req.method, headers: req.headers, body: parsed, at: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

const smtp = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 myhive-test ESMTP\r\n');
  let buffer = '';
  let inData = false;
  let messageLines = [];
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          smtpMessages.push(messageLines.join('\r\n'));
          messageLines = [];
          socket.write('250 OK queued\r\n');
        } else {
          messageLines.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }
      const command = line.trim();
      if (/^(EHLO|HELO)/i.test(command)) socket.write('250 myhive-test\r\n');
      else if (/^(MAIL FROM|RCPT TO|RSET|NOOP)/i.test(command)) socket.write('250 OK\r\n');
      else if (/^DATA/i.test(command)) {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT/i.test(command)) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else socket.write('250 OK\r\n');
    }
  });
  socket.on('error', () => undefined);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

console.log(`MyHive notifications test → ${ORIGIN}\n`);

const httpPort = await listen(receiver);
const smtpPort = await listen(smtp);
console.log(`Local receiver http://127.0.0.1:${httpPort} · fake SMTP 127.0.0.1:${smtpPort}\n`);

const created = { endpoints: [], notifications: [], alerts: [], cases: [] };

try {
  let me;
  await test('login', async () => {
    const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD });
    token = result.token;
    me = result.user;
    assert(token, 'no token');
    return me.login;
  });

  let webhookEndpoint;
  let slackEndpoint;
  let smtpEndpoint;
  await test('create endpoints (webhook thehive, slack, smtp)', async () => {
    webhookEndpoint = await call('POST', `${V1}/endpoints`, {
      name: `test-webhook-${stamp}`,
      type: 'webhook',
      config: { url: `http://127.0.0.1:${httpPort}/webhook`, method: 'POST', format: 'thehive', auth: { type: 'none' } },
    });
    created.endpoints.push(webhookEndpoint.id);
    slackEndpoint = await call('POST', `${V1}/endpoints`, {
      name: `test-slack-${stamp}`,
      type: 'slack',
      config: { webhookUrl: `http://127.0.0.1:${httpPort}/slack` },
    });
    created.endpoints.push(slackEndpoint.id);
    smtpEndpoint = await call('POST', `${V1}/endpoints`, {
      name: `test-smtp-${stamp}`,
      type: 'smtp',
      config: { host: '127.0.0.1', port: smtpPort, secure: false, user: '', password: 'supersecret', from: 'myhive@test.local' },
    });
    created.endpoints.push(smtpEndpoint.id);
    assert(webhookEndpoint.id && slackEndpoint.id && smtpEndpoint.id, 'endpoint ids missing');
    return `${webhookEndpoint.id.slice(0, 8)}…`;
  });

  let alertNotification;
  let alertImportedNotification;
  let caseNotification;
  let observableNotification;
  let disabledNotification;
  await test('create notifications', async () => {
    alertNotification = await call('POST', `${V1}/notifications`, {
      name: `AlertCreated webhook ${stamp}`,
      enabled: true,
      config: { trigger: 'AlertCreated', notifiers: [{ type: 'webhook', endpointId: webhookEndpoint.id }] },
    });
    created.notifications.push(alertNotification.id);
    alertImportedNotification = await call('POST', `${V1}/notifications`, {
      name: `AlertImported webhook ${stamp}`,
      enabled: true,
      config: { trigger: 'AlertImported', notifiers: [{ type: 'webhook', endpointId: webhookEndpoint.id }] },
    });
    created.notifications.push(alertImportedNotification.id);
    caseNotification = await call('POST', `${V1}/notifications`, {
      name: `CaseCreated slack+email ${stamp}`,
      enabled: true,
      config: {
        trigger: 'CaseCreated',
        notifiers: [
          { type: 'slack', endpointId: slackEndpoint.id },
          { type: 'email', endpointId: smtpEndpoint.id, to: ['soc@test.local'] },
        ],
      },
    });
    created.notifications.push(caseNotification.id);
    observableNotification = await call('POST', `${V1}/notifications`, {
      name: `Observable create ${stamp}`,
      enabled: true,
      config: {
        trigger: 'FilteredEvent',
        filter: { objectType: 'Observable', action: 'create' },
        notifiers: [{ type: 'webhook', endpointId: webhookEndpoint.id }],
      },
    });
    created.notifications.push(observableNotification.id);
    const disabledEndpoint = await call('POST', `${V1}/endpoints`, {
      name: `test-disabled-${stamp}`,
      type: 'webhook',
      config: { url: `http://127.0.0.1:${httpPort}/disabled`, method: 'POST', format: 'thehive', auth: { type: 'none' } },
    });
    created.endpoints.push(disabledEndpoint.id);
    disabledNotification = await call('POST', `${V1}/notifications`, {
      name: `Disabled ${stamp}`,
      enabled: false,
      config: { trigger: 'AlertCreated', notifiers: [{ type: 'webhook', endpointId: disabledEndpoint.id }] },
    });
    created.notifications.push(disabledNotification.id);
    assert(alertNotification.config.trigger === 'AlertCreated', 'trigger not stored');
    return '5 notifications';
  });

  await test('trigger and notifier shapes are normalised', async () => {
    const shapes = ['AnyEvent', { type: 'AnyEvent' }, { name: 'AnyEvent' }];
    for (const trigger of shapes) {
      const n = await call('POST', `${V1}/notifications`, {
        name: `shape ${stamp} ${typeof trigger === 'string' ? 'string' : Object.keys(trigger)[0]}`,
        enabled: false,
        config: { trigger, notifiers: [{ type: 'webhook', endpointId: webhookEndpoint.id }] },
      });
      created.notifications.push(n.id);
      assert(n.config.trigger === 'AnyEvent', `trigger not normalised: ${JSON.stringify(n.config.trigger)}`);
    }
    const embedded = await call('POST', `${V1}/notifications`, {
      name: `embedded filter ${stamp}`,
      enabled: false,
      config: {
        trigger: { name: 'FilteredEvent', filter: { objectType: 'Case', minSeverity: 2 } },
        notifiers: [{ name: 'webhook', endpointId: webhookEndpoint.id }],
      },
    });
    created.notifications.push(embedded.id);
    assert(embedded.config.trigger === 'FilteredEvent', `trigger=${JSON.stringify(embedded.config.trigger)}`);
    assert(embedded.config.filter?.objectType === 'Case', `filter=${JSON.stringify(embedded.config.filter)}`);
    assert(embedded.config.notifiers[0].type === 'webhook', `notifier=${JSON.stringify(embedded.config.notifiers[0])}`);
    return '3 trigger shapes + embedded filter + notifier name';
  });

  let alert;
  const alertTitle = `Notif alert ${stamp}`;
  const observableData = `198.51.100.${(Date.now() % 200) + 10}`;
  await test('create alert emits alert_create webhook with TheHive fields', async () => {
    alert = await call('POST', `${V1}/alerts`, {
      title: alertTitle,
      description: 'notifications test',
      type: 'notif-test',
      source: 'notifications-test',
      sourceRef: `notif-${stamp}`,
      severity: 3,
      tlp: 2,
      pap: 2,
      observables: [{ dataType: 'ip', data: observableData, message: 'nested observable' }],
    });
    created.alerts.push(alert.id);
    const event = await waitFor(() =>
      received.find((r) => r.path === '/webhook' && r.body?.objectType === 'Alert' && r.body?.action === 'create' && r.body?.object?.title === alertTitle),
    );
    assert(event.body.objectId === alert.id, `objectId=${event.body.objectId}`);
    assert(event.body._id === undefined, 'webhook body must not be confused with the object');
    assert(event.body.object._id === alert.id, `object._id=${event.body.object._id}`);
    assert(event.body.object._type === 'Alert', `object._type=${event.body.object._type}`);
    assert(typeof event.body._createdAt === 'number', '_createdAt is not epoch ms');
    assert(event.body.requestId, 'requestId missing');
    assert(event.body.organisation, 'organisation missing');

    // Inline observables emit their own create event, like TheHive.
    const inline = (alert.observables || []).find((o) => o.data === observableData);
    assert(inline, 'alert response has no inline observable');
    const observableEvent = await waitFor(() =>
      received.find(
        (r) =>
          r.path === '/webhook' &&
          r.body?.objectType === 'Observable' &&
          r.body?.action === 'create' &&
          r.body?.objectId === inline.id &&
          r.body?.rootId === alert.id,
      ),
    );
    assert(observableEvent.body.object.data === observableData, 'inline observable payload mismatch');
    return `${event.body.object._id} + observable_create`;
  });

  let caseItem;
  const caseTitle = `Notif case ${stamp}`;
  await test('promote alert to case emits slack {text} and email', async () => {
    caseItem = await call('POST', `${V1}/alerts/${alert.id}/case`, { title: caseTitle, description: 'from alert' });
    created.cases.push(caseItem.id);

    // TheHive only knows create/update/delete: an import must look like alert_update.
    const updateEvent = await waitFor(() =>
      received.find(
        (r) =>
          r.path === '/webhook' &&
          r.body?.objectType === 'Alert' &&
          r.body?.action === 'update' &&
          r.body?.objectId === alert.id &&
          r.body?.details?.operation === 'import-to-case',
      ),
    );
    assert(updateEvent.body.details, 'details missing from update event');

    // Observables copied from the alert to the case emit create events rooted at the case.
    const copied = await waitFor(() =>
      received.find(
        (r) =>
          r.path === '/webhook' &&
          r.body?.objectType === 'Observable' &&
          r.body?.action === 'create' &&
          r.body?.rootId === caseItem.id &&
          r.body?.object?.data === observableData,
      ),
    );
    assert(copied.body.details?.operation === 'create', 'operation must stay create');

    const slack = await waitFor(() => received.find((r) => r.path === '/slack' && typeof r.body?.text === 'string' && r.body.text.includes(caseTitle)));
    assert(slack.body.text.includes(`[Nuestracolmena] Case`), `unexpected slack text: ${slack.body.text}`);
    const email = await waitFor(() => smtpMessages.find((raw) => raw.includes(caseTitle)));
    assert(/^subject:/im.test(email), 'email has no subject header');
    return `case #${caseItem.number} · alert_update + copied observable`;
  });

  const caseObservable = `case-${stamp}.example`;
  await test('adding an observable emits the filtered observable event', async () => {
    await call('POST', `${V1}/cases/${caseItem.id}/observables`, { dataType: 'domain', data: caseObservable, message: 'test observable' });
    const event = await waitFor(() =>
      received.find((r) => r.path === '/webhook' && r.body?.objectType === 'Observable' && r.body?.action === 'create' && r.body?.object?.data === caseObservable),
    );
    assert(event.body.object._id === event.body.objectId, 'observable _id mismatch');
    return event.body.objectId;
  });

  await test('POST /notifications/:id/test delivers synchronously', async () => {
    const result = await call('POST', `${V1}/notifications/${alertNotification.id}/test`);
    assert(result.ok === true, JSON.stringify(result));
    assert(Array.isArray(result.results) && result.results.length === 1, `results=${JSON.stringify(result.results)}`);
    assert(result.results[0].ok === true, JSON.stringify(result.results[0]));
    return `${result.results.length} notifier`;
  });

  await test('POST /endpoints/:id/test returns a result', async () => {
    const result = await call('POST', `${V1}/endpoints/${webhookEndpoint.id}/test`, {});
    assert(result.ok === true, JSON.stringify(result));
    assert(result.status === 200, `status=${result.status}`);
    return `HTTP ${result.status}`;
  });

  await test('GET /notifications/deliveries lists attempt jobs', async () => {
    const jobs = await call('GET', `${V1}/notifications/deliveries?notificationId=${encodeURIComponent(alertNotification.id)}&limit=20`);
    assert(Array.isArray(jobs) && jobs.length >= 1, `jobs=${JSON.stringify(jobs)}`);
    assert(jobs.some((job) => job.type === 'notification' && job.status === 'Success'), 'no successful job');
    assert(jobs.every((job) => job.payload?.notificationId === alertNotification.id), 'wrong notificationId in jobs');
    return `${jobs.length} deliveries`;
  });

  await test('secrets are masked on GET and kept on update', async () => {
    let endpoints = await call('GET', `${V1}/endpoints`);
    let smtp = endpoints.find((e) => e.id === smtpEndpoint.id);
    assert(smtp.config.password === '********', `password=${smtp.config.password}`);

    await call('PATCH', `${V1}/endpoints/${smtpEndpoint.id}`, { config: { host: '127.0.0.1', port: smtpPort, secure: false, from: 'myhive@test.local' } });
    endpoints = await call('GET', `${V1}/endpoints`);
    smtp = endpoints.find((e) => e.id === smtpEndpoint.id);
    assert(smtp.config.password === '********', 'secret lost after update without password');
    assert(smtp.config.user === undefined || smtp.config.user === '', 'unexpected smtp user');

    await call('PATCH', `${V1}/endpoints/${smtpEndpoint.id}`, { config: { password: '********' } });
    endpoints = await call('GET', `${V1}/endpoints`);
    smtp = endpoints.find((e) => e.id === smtpEndpoint.id);
    assert(smtp.config.password === '********', 'mask sentinel did not keep the secret');
    return 'write-only password';
  });

  await test('a disabled notification does not fire', async () => {
    const disabledTitle = `Disabled alert ${stamp}`;
    const disabledAlert = await call('POST', `${V1}/alerts`, {
      title: disabledTitle,
      description: 'should not notify',
      type: 'notif-test',
      source: 'notifications-test',
      sourceRef: `disabled-${stamp}`,
    });
    created.alerts.push(disabledAlert.id);
    await sleep(2500);
    const fired = received.some((r) => r.path === '/disabled' && r.body?.object?.title === disabledTitle);
    assert(!fired, 'disabled notification was delivered');
    return 'no delivery';
  });

  await test('validation rejects unknown triggers and wrong endpoint types', async () => {
    await call('POST', `${V1}/notifications`, {
      name: `bad trigger ${stamp}`,
      config: { trigger: 'NoSuchTrigger', notifiers: [] },
    }, { expect: 400 });
    await call('POST', `${V1}/notifications`, {
      name: `bad endpoint ${stamp}`,
      config: { trigger: 'AnyEvent', notifiers: [{ type: 'slack', endpointId: webhookEndpoint.id }] },
    }, { expect: 400 });
    return '400s';
  });
} finally {
  for (const id of created.notifications) await call('DELETE', `${V1}/notifications/${id}`).catch(() => undefined);
  for (const id of created.endpoints) await call('DELETE', `${V1}/endpoints/${id}`).catch(() => undefined);
  for (const id of created.cases) await call('DELETE', `${V1}/cases/${id}?force=true`).catch(() => undefined);
  for (const id of created.alerts) await call('DELETE', `${V1}/alerts/${id}`).catch(() => undefined);
  await new Promise((resolve) => receiver.close(resolve));
  await new Promise((resolve) => smtp.close(resolve));
}

console.log(`\n${passed} PASS · ${failed} FAIL`);
process.exit(failed ? 1 : 0);
