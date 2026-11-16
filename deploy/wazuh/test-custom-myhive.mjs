#!/usr/bin/env node
// Prueba la integración Wazuh -> MyHive sin Wazuh ni MyHive: levanta un
// receptor HTTP local y ejecuta deploy/wazuh/custom-myhive.py contra él.
//   node deploy/wazuh/test-custom-myhive.mjs
// Se salta (exit 0) si python3 no está instalado.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'custom-myhive.py');
const SAMPLE = path.join(DIR, 'sample-alert.json');
const API_KEY = 'mh_test_key';

let received = null;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    received = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
});

function runPython(args) {
  return new Promise((resolve) => {
    const child = spawn('python3', args, { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ error, stdout, stderr, status: null }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    setTimeout(() => child.kill('SIGKILL'), 15000).unref();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const hookUrl = `http://127.0.0.1:${port}/api/v1/function/wazuh-alert`;

  const logFile = path.join(os.tmpdir(), `myhive-wazuh-${process.pid}.log`);
  process.env.MYHIVE_WAZUH_LOG = logFile;
  const result = await runPython([SCRIPT, SAMPLE, API_KEY, hookUrl]);
  server.close();

  if (result.error?.code === 'ENOENT') {
    console.log('SKIP python3 no está instalado');
    return;
  }

  try {
    assert(result.status === 0, `exit code ${result.status}; stderr: ${result.stderr.trim()}`);
    assert(received, 'el receptor no recibió ninguna petición');
    assert(received.method === 'POST', `método ${received.method}, se esperaba POST`);
    assert(received.url === '/api/v1/function/wazuh-alert', `ruta ${received.url}`);
    assert(
      received.headers.authorization === `Bearer ${API_KEY}`,
      `Authorization: ${received.headers.authorization}`,
    );
    assert(
      (received.headers['content-type'] || '').startsWith('application/json'),
      `Content-Type: ${received.headers['content-type']}`,
    );
    const body = JSON.parse(received.body);
    const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    assert(body.rule?.id === sample.rule.id, 'el cuerpo no es la alerta enviada');
    assert(body.rule?.level === 12, 'nivel de alerta distinto');
    const logLine = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    assert(logLine.includes('rule=100199') && logLine.includes('HTTP 200'), 'no se registró la línea de log esperada');
    fs.rmSync(logFile, { force: true });
    console.log('PASS custom-myhive envía POST con Bearer y el JSON de la alerta');
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
