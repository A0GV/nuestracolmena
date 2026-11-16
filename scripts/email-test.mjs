#!/usr/bin/env node
// End-to-end test of email intake: manual .eml import, reported-phishing forwards and an IMAP feeder.
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/email-test.mjs
// The IMAP part starts a throwaway GreenMail container; it is skipped when Docker is unavailable.
// Creates its own data (alerts, feeder, container) and deletes it at the end.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { ImapFlow } from 'imapflow';

const ORIGIN = (process.env.MYHIVE_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const V1 = `${ORIGIN}/api/v1`;
const LOGIN = process.env.MYHIVE_LOGIN || 'admin@myhive.local';
const PASSWORD = process.env.MYHIVE_PASSWORD || 'admin123';
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CONTAINER = 'myhive-greenmail-test';
const SMTP_PORT = 3025;
const IMAP_PORT = 3143;
const PUBLIC_IP = '45.33.32.156';
const PRIVATE_IP = '10.0.0.5';

let token = '';
let passed = 0;
let failed = 0;
let skipped = 0;
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

const md5 = (value) => createHash('md5').update(value).digest('hex');
const sha1 = (value) => createHash('sha1').update(value).digest('hex');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const ATTACHMENT = `adjunto de prueba ${stamp}`;

function phishingMessage() {
  const lines = [
    'From: "Banco Falso" <alerts@bank-secure.example>',
    'Reply-To: soporte@evil-reply.example',
    'To: victim@example.com',
    `Subject: Urgente: verifica tu cuenta ${stamp}`,
    'Date: Mon, 02 Nov 2026 10:00:00 +0000',
    `Message-ID: <phish-${stamp}@bank-secure.example>`,
    'Return-Path: <bounce@bank-secure.example>',
    'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=bank-secure.example; dkim=fail header.d=bank-secure.example; dmarc=fail',
    `Received: from mail.bank-secure.example (mail.bank-secure.example [${PUBLIC_IP}]) by mx.example.com; Mon, 2 Nov 2026 10:00:01 +0000`,
    `Received: from local (${PRIVATE_IP}) by mail.bank-secure.example; Mon, 2 Nov 2026 10:00:00 +0000`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/html; charset="utf-8"',
    '',
    `<html><body><p>Hola, entra en <a href="http://evil.example/login">https://bank-secure.example</a></p><script>alert("x")</script></body></html>`,
    '--BOUND',
    'Content-Type: text/plain; charset="utf-8"; name="nota.txt"',
    'Content-Disposition: attachment; filename="nota.txt"',
    '',
    ATTACHMENT,
    '--BOUND--',
    '',
  ];
  return lines.join('\r\n');
}

function reportedMessage(inner) {
  const lines = [
    'From: "SOC" <soc@example.com>',
    'To: phishing@example.com',
    `Subject: FW: correo sospechoso ${stamp}`,
    'Date: Mon, 02 Nov 2026 10:05:00 +0000',
    `Message-ID: <report-${stamp}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    '--OUT',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Reenvío el correo sospechoso para su análisis.',
    '--OUT',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="original.eml"',
    '',
    inner,
    '--OUT--',
    '',
  ];
  return lines.join('\r\n');
}

function importForm(messages) {
  const form = new FormData();
  for (const [index, raw] of messages.entries()) {
    form.append('file', new Blob([raw], { type: 'message/rfc822' }), `message-${index + 1}-${stamp}.eml`);
  }
  return form;
}

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

function dockerAvailable() {
  const result = docker(['ps']);
  return result.status === 0;
}

function waitGreeting(port, pattern, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let buffer = '';
      let settled = false;
      const retry = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(error || new Error(`timeout waiting for ${port}`));
        else setTimeout(attempt, 500);
      };
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (pattern.test(buffer)) {
          settled = true;
          socket.destroy();
          resolve();
        }
      });
      socket.once('error', () => retry());
      socket.once('close', () => retry());
    };
    attempt();
  });
}

function dotStuff(raw) {
  const normalised = String(raw).replace(/\r?\n/g, '\r\n');
  const withCrlf = normalised.endsWith('\r\n') ? normalised : `${normalised}\r\n`;
  return withCrlf.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
}

function smtpSend(raw, from = `reporter-${stamp}@example.com`, to = 'soc@localhost') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: SMTP_PORT });
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });
    let buffer = '';
    let state = 0;
    const finish = (error) => {
      if (error) { socket.destroy(); reject(error); }
      else { socket.end(); resolve(); }
    };
    const onReply = (line) => {
      if (process.env.SMTP_DEBUG) console.error(`SMTP< ${line}`);
      const code = Number(line.slice(0, 3));
      try {
        if (state === 0 && code === 220) { socket.write('EHLO localhost\r\n'); state = 1; }
        else if (state === 1 && code === 250) { socket.write(`MAIL FROM:<${from}>\r\n`); state = 2; }
        else if (state === 2 && code === 250) { socket.write(`RCPT TO:<${to}>\r\n`); state = 3; }
        else if (state === 3 && code === 250) { socket.write('DATA\r\n'); state = 4; }
        else if (state === 4 && code === 354) { socket.write(`${dotStuff(raw)}.\r\n`); state = 5; }
        else if (state === 5 && code === 250) { socket.write('QUIT\r\n'); state = 6; }
        else if (state === 6 && code === 221) finish();
        else if (code >= 400) finish(new Error(`SMTP ${line}`));
      } catch (error) {
        finish(error);
      }
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line[3] === ' ') onReply(line);
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('SMTP connection closed before the transaction completed')));
  });
}

async function deleteAlert(id) {
  if (id) await call('DELETE', `/alerts/${id}`).catch(() => undefined);
}

async function stopContainer() {
  docker(['rm', '-f', CONTAINER]);
}

console.log(`MyHive email intake test → ${ORIGIN}\n`);

const phishingRaw = phishingMessage();
const reportedRaw = reportedMessage(phishingRaw);
let alertIds = [];
let feederId = null;

try {
  await test('login', async () => {
    const result = await call('POST', '/auth/login', { login: LOGIN, password: PASSWORD }, { auth: '' });
    token = result.token;
    assert(token, 'no token');
    return result.user?.login;
  });

  let phishing;
  let reported;
  let reimport;

  await test('importar .eml crea una alerta con observables y adjuntos', async () => {
    const result = await call('POST', '/alerts/import-eml', importForm([phishingRaw, reportedRaw]));
    assert(result.created === 2, `created=${result.created} ${JSON.stringify(result).slice(0, 500)}`);
    assert(result.results?.length === 2, `results=${result.results?.length}`);
    phishing = await call('GET', `/alerts/${result.results[0].alertId}`);
    reported = await call('GET', `/alerts/${result.results[1].alertId}`);
    alertIds = [phishing.id, reported.id];
    return `#${phishing.id.slice(0, 8)}, #${reported.id.slice(0, 8)}`;
  });

  await test('alerta de phishing: título, descripción y cabeceras', async () => {
    assert(phishing.type === 'email', `type=${phishing.type}`);
    assert(phishing.source === 'manual-eml', `source=${phishing.source}`);
    assert(phishing.title === `Urgente: verifica tu cuenta ${stamp}`, `title=${phishing.title}`);
    assert(phishing.severity === 2 && phishing.tlp === 2, `severity=${phishing.severity} tlp=${phishing.tlp}`);
    assert((phishing.tags || []).includes('email'), `tags=${JSON.stringify(phishing.tags)}`);
    for (const section of ['## Cabeceras', '## Cadena de recepción', '## Cuerpo']) {
      assert(phishing.description.includes(section), `missing ${section}`);
    }
    assert(phishing.description.includes('SPF=pass') && phishing.description.includes('DMARC=fail'), 'auth summary missing');
    assert(phishing.description.includes(PUBLIC_IP), 'public IP missing from received chain');
    assert(phishing.description.includes('Hola, entra en'), 'body missing');
    return 'secciones OK';
  });

  await test('alerta de phishing: observables (mail, dominio, IP pública, URLs, adjuntos)', async () => {
    const obs = phishing.observables || [];
    const find = (type, value) => obs.find((item) => item.dataType === type && item.data === value);
    assert(find('mail', 'alerts@bank-secure.example'), 'sender missing');
    assert(find('mail', 'soporte@evil-reply.example'), 'reply-to missing');
    assert(find('mail', 'bounce@bank-secure.example'), 'return-path missing');
    assert(find('mail_subject', `Urgente: verifica tu cuenta ${stamp}`), 'mail_subject missing');
    assert(find('domain', 'bank-secure.example'), 'sender domain missing');
    assert(find('ip', PUBLIC_IP), 'public IP observable missing');
    assert(!find('ip', PRIVATE_IP), 'private IP should be skipped');
    const mismatch = obs.find((item) => item.dataType === 'url' && (item.tags || []).includes('link-mismatch'));
    assert(mismatch && mismatch.data.includes('evil.example'), `link-mismatch=${JSON.stringify(mismatch)}`);
    assert(!obs.some((item) => item.dataType === 'url' && item.data.includes('bank-secure.example')), 'displayed URL must not become a url observable');
    assert(mismatch.message && mismatch.message.includes('bank-secure.example'), `link-mismatch message=${mismatch.message}`);
    assert(obs.every((item) => !item.ioc), 'nothing should be IOC by default');

    const file = find('file', 'nota.txt');
    assert(file, 'attachment file observable missing');
    assert(file.attachment, 'attachment missing');
    for (const hash of [md5(ATTACHMENT), sha1(ATTACHMENT), sha256(ATTACHMENT)]) {
      assert(find('hash', hash), `hash ${hash} missing`);
    }
    const original = obs.find((item) => item.dataType === 'file' && (item.tags || []).includes('original-email'));
    assert(original && original.data === 'original-email.eml', `original-email=${JSON.stringify(original)}`);
    assert(original.attachment, 'original-email attachment missing');
    return `${obs.length} observables`;
  });

  await test('reenvío reportado: alerta sobre el mensaje interno y remitente', async () => {
    assert(reported.title === `Reportado: Urgente: verifica tu cuenta ${stamp}`, `title=${reported.title}`);
    assert((reported.tags || []).includes('phishing-report'), `tags=${JSON.stringify(reported.tags)}`);
    assert(reported.description.includes('soc@example.com'), 'reporter missing from description');
    const reporter = (reported.observables || []).find((item) => item.dataType === 'mail' && item.data === 'soc@example.com');
    assert(reporter, 'reporter mail observable missing');
    assert(reporter.message === 'Reportado por', `message=${reporter.message}`);
    assert((reported.observables || []).some((item) => item.dataType === 'file' && item.data === 'nota.txt'), 'inner attachment missing');
    assert((reported.observables || []).some((item) => item.dataType === 'ip' && item.data === PUBLIC_IP), 'inner public IP missing');
    return 'mensaje interno OK';
  });

  await test('reimportar el mismo .eml no crea duplicados', async () => {
    reimport = await call('POST', '/alerts/import-eml', importForm([phishingRaw]));
    assert(reimport.created === 0, `created=${reimport.created}`);
    assert(reimport.unchanged === 1, `unchanged=${reimport.unchanged}`);
    assert(reimport.results?.[0]?.created === false, JSON.stringify(reimport.results?.[0]));
    return 'sin duplicados';
  });

  if (!dockerAvailable()) {
    skipped++;
    console.log('SKIP IMAP (Docker no disponible: no se puede arrancar GreenMail)');
  } else {
    try {
      await test('arrancar GreenMail', async () => {
        await stopContainer();
        const result = docker([
          'run', '-d', '--rm', '--name', CONTAINER,
          '-p', `${SMTP_PORT}:3025`, '-p', `${IMAP_PORT}:3143`,
          '-e', 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled',
          'greenmail/standalone:2.1.0',
        ]);
        assert(result.status === 0, `docker run failed: ${result.stderr || result.stdout}`);
        await waitGreeting(SMTP_PORT, /^220/m);
        await waitGreeting(IMAP_PORT, /^\* OK/m);
        return result.stdout.trim().slice(0, 12);
      });

      await test('entregar los dos correos por SMTP', async () => {
        await smtpSend(phishingRaw);
        await smtpSend(reportedRaw);
        return '2 mensajes';
      });

      await test('crear feeder IMAP', async () => {
        const feeder = await call('POST', '/email/feeders', {
          name: `GreenMail ${stamp}`,
          host: '127.0.0.1',
          port: IMAP_PORT,
          secure: false,
          verifyTls: false,
          user: 'soc@localhost',
          password: 'soc@localhost',
          mailbox: 'INBOX',
          intervalMinutes: 5,
          markSeen: true,
          maxPerRun: 50,
          tlp: 2,
          severity: 2,
          tags: ['greenmail', stamp],
          enabled: true,
        });
        feederId = feeder.id;
        cleanup.push(() => call('DELETE', `/email/feeders/${feederId}`).catch(() => undefined));
        assert(feeder.config?.password === '********', `password not masked: ${feeder.config?.password}`);
        assert(feeder.config?.type === 'imap', `type=${feeder.config?.type}`);
        return feeder.id.slice(0, 8);
      });

      await test('probar conexión lista el buzón', async () => {
        const result = await call('POST', `/email/feeders/${feederId}/test`);
        assert(result.ok, JSON.stringify(result));
        assert(result.messages >= 2, `messages=${result.messages}`);
        assert(result.unseen >= 2, `unseen=${result.unseen}`);
        return `${result.mailbox}: ${result.messages} mensajes`;
      });

      await test('ejecutar feeder crea 2 alertas', async () => {
        const feeder = await call('POST', `/email/feeders/${feederId}/run`);
        const summary = feeder.config?.lastResult;
        assert(summary, 'missing lastResult');
        assert(summary.created === 2, `created=${summary.created} fetched=${summary.fetched} errors=${JSON.stringify(summary.errors)}`);
        assert(summary.errors?.length === 0, `errors=${JSON.stringify(summary.errors)}`);
        const list = await call('GET', `/alerts?source=${encodeURIComponent(feeder.name)}&pageSize=50`);
        const items = (list.items || []).filter((item) => (item.tags || []).includes(stamp));
        assert(items.length === 2, `alerts=${items.length}`);
        for (const item of items) alertIds.push(item.id);
        const detail = await call('GET', `/alerts/${items.find((item) => item.title.startsWith('Reportado:'))?.id}`);
        assert(detail?.title.startsWith('Reportado:'), `reported title=${detail?.title}`);
        return `2 alertas (${feeder.name})`;
      });

      await test('segunda ejecución no crea alertas y los mensajes quedan vistos', async () => {
        const feeder = await call('POST', `/email/feeders/${feederId}/run`);
        const summary = feeder.config?.lastResult;
        assert(summary.created === 0, `created=${summary.created}`);
        const client = new ImapFlow({
          host: '127.0.0.1', port: IMAP_PORT, secure: false,
          auth: { user: 'soc@localhost', pass: 'soc@localhost' }, logger: false,
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock('INBOX');
          try {
            const messages = await client.fetchAll('1:*', { flags: true });
            assert(messages.length === 2, `messages=${messages.length}`);
            assert(messages.every((message) => message.flags?.has('\\Seen')), 'some message is still unseen');
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => undefined);
        }
        return '0 nuevas · todos vistos';
      });
    } finally {
      await stopContainer();
    }
  }
} finally {
  for (const id of alertIds) await deleteAlert(id);
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
  await stopContainer();
}

console.log(`\n${passed} PASS · ${failed} FAIL${skipped ? ` · ${skipped} SKIP` : ''}`);
process.exit(failed ? 1 : 0);
