#!/usr/bin/env node
// End-to-end UI smoke test for MyHive.
//
//   MYHIVE_API=http://127.0.0.1:4199 node scripts/ui-test.cjs
//
// By default it serves the freshly built apps/web/dist with a tiny static +
// /api proxy server on a random port (so it never touches the production web on
// 8088/API on 4100). Set MYHIVE_WEB to use an already-running web instead.
//
// Playwright is optional: if PLAYWRIGHT_CORE or CHROME_PATH is missing the test
// exits 0 with a SKIP message.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || '/tmp/job-hunter-qa/node_modules/playwright-core';
const CHROME_PATH = process.env.CHROME_PATH || require('path').join(require('os').homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const API = (process.env.MYHIVE_API || process.env.MYHIVE_URL || 'http://127.0.0.1:4199').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
const EXPLICIT_WEB = process.env.MYHIVE_WEB || '';
const SHOTS_DIR = process.env.UI_SHOTS_DIR || '/tmp/myhive-ui-shots';
const DIST = path.join(ROOT, 'apps', 'web', 'dist');

if (!fs.existsSync(PLAYWRIGHT_CORE)) {
  console.log(`SKIP ui-test: playwright-core not found at ${PLAYWRIGHT_CORE}`);
  process.exit(0);
}
if (!fs.existsSync(CHROME_PATH)) {
  console.log(`SKIP ui-test: Chrome not found at ${CHROME_PATH}`);
  process.exit(0);
}
if (!EXPLICIT_WEB && !fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log(`SKIP ui-test: ${DIST}/index.html not found; build the web first`);
  process.exit(1);
}
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const { chromium } = require(PLAYWRIGHT_CORE);
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let passed = 0;
let failed = 0;
const failures = [];
const browserErrors = [];
const apiFailures = [];
const cleanup = [];
let tracking = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

function safeName(name) {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 90);
}

async function apiCall(token, method, apiPath, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status}: ${String(text).slice(0, 400)}`);
  return data;
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const target = new URL(url.pathname + url.search, API);
        const proxy = http.request({
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxy.on('error', (error) => {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Proxy error: ${error.message}`);
        });
        req.pipe(proxy);
        return;
      }
      const decoded = decodeURIComponent(url.pathname);
      let filePath = path.join(DIST, decoded);
      if (decoded === '/' || !filePath.startsWith(DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (decoded !== '/' && !decoded.startsWith('/assets/')) {
          // Unknown SPA route: serve index.html.
        } else if (decoded.startsWith('/assets/')) {
          console.error(`[ui-test] static asset missing: ${decoded}`);
        }
        filePath = path.join(DIST, 'index.html');
      }
      fs.readFile(filePath, (error, buffer) => {
        if (error) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(buffer);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

const WHITELIST = [
  // A missing favicon is not an API failure; entries must explain why.
];

function isWhitelisted(url, status) {
  return WHITELIST.some((entry) => entry.match(url, status));
}

async function waitForApp(page) {
  await page.waitForTimeout(250);
  await page.waitForSelector('.ant-spin-spinning', { state: 'detached', timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(200);
}

async function goto(page, base, route) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${safeName(name)}.png`), fullPage: false }).catch(() => undefined);
}

async function checkNoOverflow(page, selector, label) {
  const result = await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return { found: false, overflow: 0, scrollWidth: 0, clientWidth: 0 };
    return {
      found: true,
      overflow: element.scrollWidth - element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  }, selector);
  assert(
    !result.found || result.overflow <= 8,
    `${label} overflows horizontally by ${result.overflow}px (${result.scrollWidth} > ${result.clientWidth})`,
  );
}

async function closeTopOverlay(page) {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(350);
  if (await page.locator('.ant-modal-content:visible').count()) {
    const modalClose = page.locator('.ant-modal-close:visible').last();
    if (await modalClose.count()) await modalClose.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  if (await page.locator('.ant-drawer-content:visible').count()) {
    const drawerClose = page.locator('.ant-drawer-close:visible').last();
    if (await drawerClose.count()) await drawerClose.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.locator('.ant-modal-content:visible, .ant-drawer-content:visible').last().waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
}

async function login(page, base, loginValue, password) {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#login', loginValue);
  await page.fill('#password', password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL('**/cases', { timeout: 15000 });
  await waitForApp(page);
}

async function main() {
  const token = (await apiCall('', 'POST', '/api/v1/auth/login', { login: 'admin@myhive.local', password: 'admin123' })).token;
  const dashboards = await apiCall(token, 'GET', '/api/v1/dashboards');
  const dashboard = Array.isArray(dashboards) ? dashboards[0] : null;

  let tempCase = await apiCall(token, 'POST', '/api/v1/cases', {
    title: `UI smoke case ${stamp}`,
    description: 'Caso temporal creado por scripts/ui-test.cjs',
    severity: 2,
    tlp: 2,
    pap: 2,
    status: 'New',
    tags: ['ui-smoke'],
  });
  cleanup.push(() => apiCall(token, 'DELETE', `/api/v1/cases/${tempCase.id}?force=true`).catch(() => undefined));

  const tempAlert = await apiCall(token, 'POST', '/api/v1/alerts', {
    type: 'ui-smoke',
    source: 'ui-test',
    sourceRef: `ui-${stamp}`,
    title: `UI smoke alert ${stamp}`,
    description: 'Alerta temporal creada por scripts/ui-test.cjs',
    severity: 2,
    tlp: 2,
    pap: 2,
    status: 'New',
  });
  cleanup.push(() => apiCall(token, 'DELETE', `/api/v1/alerts/${tempAlert.id}`).catch(() => undefined));

  let tempDashboard = null;
  if (!dashboard) {
    tempDashboard = await apiCall(token, 'POST', '/api/v1/dashboards', {
      name: `UI smoke dashboard ${stamp}`,
      description: 'Temporal',
      widgets: [],
    });
    cleanup.push(() => apiCall(token, 'DELETE', `/api/v1/dashboards/${tempDashboard.id}`).catch(() => undefined));
  }
  const dashboardId = dashboard?.id || tempDashboard?.id;

  let staticServer = null;
  let base = EXPLICIT_WEB.replace(/\/+$/, '');
  if (!base) {
    const started = await startStaticServer();
    staticServer = started.server;
    base = started.base;
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => {
      browserErrors.push(String(error?.message || error));
      console.log(`     pageerror: ${String(error?.message || error).split('\n')[0]}`);
    });
    page.on('response', (response) => {
      if (!tracking) return;
      const url = response.url();
      if (!url.includes('/api/')) return;
      const status = response.status();
      if (status >= 400 && !isWhitelisted(url, status)) {
        apiFailures.push({ url, status });
        console.log(`     api ${status}: ${url.replace(base, '')}`);
      }
    });

    await step('login as admin', async () => {
      await login(page, base, 'admin@myhive.local', 'admin123');
      assert(await page.locator('.myhive-shell').count() === 1, 'app shell not rendered');
      await shot(page, '01-admin-login-cases');
      tracking = true;
    });

    await step('cases list + new case drawer', async () => {
      await goto(page, base, '/cases');
      assert(await page.getByText('Casos', { exact: true }).count() > 0, 'cases page not rendered');
      await shot(page, '02-cases-list');
      await page.getByRole('button', { name: 'Crear caso' }).first().click();
      await page.waitForSelector('.ant-drawer-content', { timeout: 5000 });
      await page.waitForTimeout(650);
      await checkNoOverflow(page, '.ant-drawer-body', 'new case drawer');
      await shot(page, '03-new-case-drawer');
      await closeTopOverlay(page);
    });

    await step('case detail tabs + TTP matrix', async () => {
      const tabs = ['general', 'tasks', 'observables', 'procedures', 'linked-alerts', 'attachments', 'report', 'shares', 'timeline'];
      for (const tab of tabs) {
        await goto(page, base, `/cases/${tempCase.id}/${tab}`);
        assert(await page.getByText(`#${tempCase.number}`, { exact: false }).count() > 0, `case header missing on ${tab}`);
        await shot(page, `04-case-${tab}`);
      }
      await goto(page, base, `/cases/${tempCase.id}/procedures`);
      await page.getByRole('button', { name: 'Matriz' }).click();
      await page.waitForTimeout(500);
      await shot(page, '05-case-ttp-matrix');
    });

    await step('case observables table layout', async () => {
      await goto(page, base, '/cases/' + tempCase.id + '/observables');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 2, `page overflows horizontally by ${overflow}px`);
      const fixedActions = await page.locator('.ant-table-cell-fix-right').count();
      assert(fixedActions > 0, 'observables actions column is not fixed');
      await shot(page, '06-case-observables-layout');
    });

    await step('case modals: add observable, add file, add TTP', async () => {
      await goto(page, base, `/cases/${tempCase.id}/observables`);
      await page.getByRole('button', { name: 'Añadir observable' }).click();
      await page.locator('.ant-modal-content:visible').last().waitFor({ timeout: 5000 });
      await page.waitForTimeout(600);
      await checkNoOverflow(page, '.ant-modal-body', 'add observable modal');
      await shot(page, '07-add-observable-modal');
      await closeTopOverlay(page);
      await page.getByRole('button', { name: 'Añadir fichero' }).click();
      await page.locator('.ant-modal-content:visible').last().waitFor({ timeout: 5000 });
      await page.waitForTimeout(600);
      await checkNoOverflow(page, '.ant-modal-body', 'add file modal');
      await shot(page, '08-add-file-modal');
      await closeTopOverlay(page);
      await goto(page, base, `/cases/${tempCase.id}/procedures`);
      await page.getByRole('button', { name: 'Añadir TTP' }).click();
      await page.locator('.ant-modal-content:visible').last().waitFor({ timeout: 5000 });
      await page.waitForTimeout(600);
      await checkNoOverflow(page, '.ant-modal-body', 'add TTP modal');
      await shot(page, '09-add-ttp-modal');
      await closeTopOverlay(page);
    });

    await step('case report generation', async () => {
      await goto(page, base, `/cases/${tempCase.id}/report`);
      await page.getByRole('button', { name: 'Generar reporte' }).click();
      await page.waitForSelector('text=Descargar .md', { timeout: 10000 });
      assert(await page.getByText(`Case #${tempCase.number}`, { exact: false }).count() > 0, 'report content missing');
      await shot(page, '10-case-report');
    });

    await step('alerts list + detail drawer', async () => {
      await goto(page, base, '/alerts');
      assert(await page.getByText('Alertas', { exact: true }).count() > 0, 'alerts page not rendered');
      await shot(page, '11-alerts-list');
      const eye = page.locator('button:has(.anticon-eye)').first();
      assert(await eye.count() > 0, 'no alert eye button');
      await eye.click();
      await page.waitForSelector('.ant-drawer-content', { timeout: 5000 });
      await page.waitForTimeout(650);
      await page.getByText(tempAlert.title, { exact: false }).first().waitFor({ timeout: 10000 });
      assert(await page.getByText(tempAlert.title, { exact: false }).count() > 0, 'alert title not visible in drawer');
      await checkNoOverflow(page, '.ant-drawer-body', 'alert detail drawer');
      await shot(page, '12-alert-detail-drawer');
      await closeTopOverlay(page);
    });

    await step('tasks page + my tasks filter', async () => {
      await goto(page, base, '/global-tasks');
      assert(await page.getByRole('heading', { name: 'Tareas' }).count() > 0, 'tasks page not rendered');
      await page.getByText('Mis tareas', { exact: true }).click();
      await page.waitForTimeout(500);
      await shot(page, '13-tasks');
    });

    await step('dashboards + dashboard view', async () => {
      await goto(page, base, '/dashboards');
      assert(await page.getByRole('heading', { name: 'Dashboards' }).count() > 0, 'dashboards page not rendered');
      await shot(page, '14-dashboards');
      if (dashboardId) {
        await goto(page, base, `/dashboards/${dashboardId}`);
        await page.waitForTimeout(600);
        assert(await page.locator('.recharts-responsive-container').count() > 0 || await page.getByText('Sin widgets').count() > 0, 'dashboard widgets not rendered');
        await shot(page, '15-dashboard-view');
      }
    });

    await step('search with a query', async () => {
      await goto(page, base, '/search?q=phishing');
      assert(await page.getByRole('heading', { name: 'Búsqueda' }).count() > 0, 'search page not rendered');
      await page.waitForTimeout(500);
      await shot(page, '16-search');
    });

    await step('knowledge base', async () => {
      await goto(page, base, '/knowledge-base');
      assert(await page.getByRole('heading', { name: 'Knowledge base' }).count() > 0, 'knowledge base not rendered');
      await shot(page, '17-knowledge-base');
    });

    await step('settings page', async () => {
      await goto(page, base, '/settings');
      assert(await page.getByRole('heading', { name: 'Ajustes de cuenta' }).count() > 0, 'settings page not rendered');
      await shot(page, '18-settings');
    });

    const adminTabs = ['organisations', 'users', 'profiles', 'statuses', 'custom-fields', 'tags', 'templates', 'patterns', 'platform', 'audit', 'cortex-misp', 'integrations'];
    for (const tab of adminTabs) {
      await step(`admin tab: ${tab}`, async () => {
        await goto(page, base, `/admin?tab=${tab}`);
        assert(await page.getByRole('heading', { name: /Administración/i }).count() > 0, 'admin page not rendered');
        await page.waitForTimeout(400);
        await shot(page, `19-admin-${tab}`);
      });
    }

    await step('automation: new notification modal', async () => {
      await goto(page, base, '/admin?tab=integrations');
      await page.getByRole('button', { name: 'Nueva notificación' }).click();
      await page.locator('.ant-modal-content:visible').last().waitFor({ timeout: 5000 });
      await page.waitForTimeout(600);
      await checkNoOverflow(page, '.ant-modal-body', 'new notification modal');
      await shot(page, '20-new-notification');
      await closeTopOverlay(page);
    });

    await step('automation: new SLA rule modal', async () => {
      await goto(page, base, '/admin?tab=integrations');
      await page.getByRole('button', { name: 'Nueva regla SLA' }).click();
      await page.locator('.ant-modal-content:visible').last().waitFor({ timeout: 5000 });
      await page.waitForTimeout(600);
      await checkNoOverflow(page, '.ant-modal-body', 'new SLA rule modal');
      await shot(page, '21-new-sla-rule');
      await closeTopOverlay(page);
    });

    await step('automation: new function drawer', async () => {
      await goto(page, base, '/admin?tab=integrations');
      await page.getByRole('button', { name: 'Nueva función' }).click();
      await page.waitForSelector('.ant-drawer-content', { timeout: 5000 });
      await page.waitForTimeout(650);
      await checkNoOverflow(page, '.ant-drawer-body', 'new function drawer');
      await shot(page, '22-new-function');
      await closeTopOverlay(page);
    });

    await step('no page errors after admin navigation', async () => {
      assert(browserErrors.length === 0, `pageerror(s): ${browserErrors.join(' | ')}`);
    });

    await step('no unexpected failed API responses (admin)', async () => {
      assert(apiFailures.length === 0, `failed API calls: ${apiFailures.map((f) => `${f.status} ${f.url}`).join(' | ')}`);
    });

    await step('org-admin: own-organisation user management UI', async () => {
      // The seeded admin is org-admin in the Partner organisation.
      await page.locator('.myhive-top-actions .ant-select').click();
      await page.locator('.ant-select-item-option').filter({ hasText: 'Partner' }).click();
      await page.waitForTimeout(900);
      await goto(page, base, '/admin?tab=users');
      await page.getByText('Usuarios de Partner', { exact: false }).first().waitFor({ timeout: 10000 });
      assert(await page.getByRole('button', { name: 'Nuevo usuario' }).count() > 0, 'org-admin cannot create users');
      assert(await page.locator('.ant-tabs-tab').filter({ hasText: 'Organizaciones' }).count() === 0, 'organisations tab should be hidden for org-admin');
      assert(await page.locator('.ant-tabs-tab').filter({ hasText: 'Perfiles' }).count() === 0, 'profiles tab should be hidden for org-admin');
      await page.getByRole('button', { name: 'Nuevo usuario' }).click();
      await page.locator('.ant-modal-content:visible').last().waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
      assert(await page.locator('.ant-modal-body #organisationId').count() === 0, 'org-admin should not choose another organisation');
      await checkNoOverflow(page, '.ant-modal-body', 'org-admin new user modal');
      await shot(page, '20b-org-admin-new-user');
      await closeTopOverlay(page);
    });

    await context.close();

    // ------------------------------------------------------------------ analyst
    const analystContext = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const analyst = await analystContext.newPage();
    analyst.setDefaultTimeout(15000);
    tracking = false;
    const analystErrors = [];
    analyst.on('pageerror', (error) => analystErrors.push(String(error?.message || error)));

    await step('login as seeded analyst', async () => {
      await login(analyst, base, 'analyst@myhive.local', 'analyst123');
      assert(await analyst.locator('.myhive-shell').count() === 1, 'analyst app shell not rendered');
      await shot(analyst, '23-analyst-cases');
      tracking = true;
    });

    await step('analyst: admin-only configuration is hidden', async () => {
      assert(await analyst.locator('.myhive-rail .anticon-appstore').count() === 0, 'admin rail is visible to analyst');
      await goto(analyst, base, '/cases');
      assert(await analyst.getByRole('button', { name: 'Crear caso' }).count() > 0, 'create case missing for analyst');
      await shot(analyst, '24-analyst-cases-actions');
    });

    await step('analyst: daily actions are visible', async () => {
      await goto(analyst, base, '/alerts');
      assert(await analyst.getByRole('button', { name: 'Nueva alerta' }).count() > 0, 'new alert missing for analyst');
      assert(await analyst.getByRole('button', { name: 'Importar .eml' }).count() > 0, 'eml import missing for analyst');
      await goto(analyst, base, `/cases/${tempCase.id}`);
      assert(await analyst.getByRole('button', { name: 'Editar' }).count() > 0, 'edit case missing for analyst');
      await goto(analyst, base, `/cases/${tempCase.id}/observables`);
      assert(await analyst.getByRole('button', { name: 'Añadir observable' }).count() > 0, 'add observable missing for analyst');
      await goto(analyst, base, `/cases/${tempCase.id}/procedures`);
      assert(await analyst.getByRole('button', { name: 'Añadir TTP' }).count() > 0, 'add TTP missing for analyst');
      await shot(analyst, '25-analyst-case-actions');
    });

    await step('analyst: no page errors', async () => {
      assert(analystErrors.length === 0, `pageerror(s): ${analystErrors.join(' | ')}`);
    });

    await step('analyst: no unexpected failed API responses', async () => {
      const relevant = apiFailures.filter((failure) => failure.url.includes('/api/'));
      assert(relevant.length === 0, `failed API calls: ${relevant.map((f) => `${f.status} ${f.url}`).join(' | ')}`);
    });

    await analystContext.close();
  } finally {
    await browser.close().catch(() => undefined);
    if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch { /* best effort */ }
    }
  }

  console.log(`\n${passed} PASS · ${failed} FAIL · screenshots in ${SHOTS_DIR}`);
  if (failed) {
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`FAIL ui-test: ${error?.stack || error}`);
  process.exit(1);
});
