#!/usr/bin/env node
// End-to-end test for observable-based correlation (related/similar cases, sightings, seen counts).
//   MYHIVE_URL=http://127.0.0.1:4100 node scripts/correlation-test.mjs
// MYHIVE_URL may include /api/v1; both forms are accepted.

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

function byId(list, id) {
  return (list || []).find((item) => item.id === id);
}

const octet = (Date.now() % 180) + 20;
const IP = `203.0.113.${octet}`;
const UNRELATED_IP = `198.51.100.${octet}`;
const DOMAIN = `corr-${stamp}.example`;
const HASH = `44d88612fea8a8f36de82e1278abb0${(Date.now() % 10)}${stamp.slice(-4)}`.slice(0, 64).padEnd(64, '0');
const tag = `corr-test-${stamp}`;

let caseA;
let caseB;
let caseC;
let caseE;
let alertD;
let alertSourceRef;

console.log(`MyHive correlation test → ${ORIGIN}\n`);

try {
  await test('login', async () => {
    const result = await call('POST', `${V1}/auth/login`, { login: LOGIN, password: PASSWORD });
    token = result.token;
    assert(token, 'no token');
    return result.user?.login;
  });

  await test('create case A with ip X, domain Y and hash Z', async () => {
    caseA = await call('POST', `${V1}/cases`, {
      title: `Correlation A ${stamp}`,
      description: 'correlation test',
      severity: 3,
      tags: [tag],
      observables: [
        { dataType: 'ip', data: IP, ioc: true },
        { dataType: 'domain', data: DOMAIN, ioc: true },
        { dataType: 'hash', data: HASH, ioc: false },
      ],
    });
    cleanup.push(() => call('DELETE', `${V1}/cases/${caseA.id}?force=true`).catch(() => undefined));
    assert(caseA.id && caseA.observables?.length === 3, `observables=${caseA.observables?.length}`);
    return `#${caseA.number} · ${caseA.observables.length} observables`;
  });

  await test('create case B with ip X and hash Z', async () => {
    caseB = await call('POST', `${V1}/cases`, {
      title: `Correlation B ${stamp}`,
      description: 'correlation test',
      severity: 2,
      tags: [tag],
      observables: [
        { dataType: 'ip', data: IP, ioc: true },
        { dataType: 'hash', data: HASH, ioc: true },
      ],
    });
    cleanup.push(() => call('DELETE', `${V1}/cases/${caseB.id}?force=true`).catch(() => undefined));
    assert(caseB.observables?.length === 2, `observables=${caseB.observables?.length}`);
    return `#${caseB.number}`;
  });

  await test('create unrelated case C', async () => {
    caseC = await call('POST', `${V1}/cases`, {
      title: `Correlation C ${stamp}`,
      description: 'unrelated',
      observables: [{ dataType: 'ip', data: UNRELATED_IP, ioc: true }],
    });
    cleanup.push(() => call('DELETE', `${V1}/cases/${caseC.id}?force=true`).catch(() => undefined));
    return `#${caseC.number}`;
  });

  await test('create alert D with ip X and domain Y', async () => {
    alertSourceRef = `corr-alert-${stamp}`;
    alertD = await call('POST', `${V1}/alerts`, {
      title: `Correlation alert D ${stamp}`,
      description: 'correlation test alert',
      type: 'correlation-test',
      source: 'correlation-test',
      sourceRef: alertSourceRef,
      severity: 3,
      tags: [tag],
      observables: [
        { dataType: 'ip', data: IP, ioc: true },
        { dataType: 'domain', data: DOMAIN, ioc: true },
      ],
    });
    cleanup.push(() => call('DELETE', `${V1}/alerts/${alertD.id}`).catch(() => undefined));
    assert(alertD.id && alertD.observables?.length === 2, JSON.stringify(alertD).slice(0, 250));
    return alertD.id;
  });

  await test('create case E whose ip X is ignoreSimilarity', async () => {
    caseE = await call('POST', `${V1}/cases`, {
      title: `Correlation E ignored ${stamp}`,
      description: 'ignoreSimilarity',
      observables: [{ dataType: 'ip', data: IP, ioc: true, ignoreSimilarity: true }],
    });
    cleanup.push(() => call('DELETE', `${V1}/cases/${caseE.id}?force=true`).catch(() => undefined));
    return `#${caseE.number}`;
  });

  await test('related(A) = B with 2 shared observables, not C/E', async () => {
    const related = await call('GET', `${V1}/cases/${caseA.id}/related`);
    assert(Array.isArray(related), 'not an array');
    const ids = related.map((item) => item.case.id);
    assert(ids.includes(caseB.id), `B missing: ${JSON.stringify(ids)}`);
    assert(!ids.includes(caseC.id), 'unrelated C listed');
    assert(!ids.includes(caseE.id), 'ignoreSimilarity case E listed');
    assert(!ids.includes(caseA.id), 'case A listed itself');
    const b = related.find((item) => item.case.id === caseB.id);
    assert(b.sharedCount === 2, `sharedCount=${b.sharedCount}`);
    assert(b.sharedObservables.length === 2, `sharedObservables=${b.sharedObservables.length}`);
    assert(Math.abs(b.ratio - 2 / 3) < 0.001, `ratio=${b.ratio}`);
    assert(b.case.number === caseB.number && b.case.title === caseB.title, 'case summary missing');
    return `${b.sharedCount} shared · ratio ${b.ratio.toFixed(2)}`;
  });

  await test('related(B) includes A', async () => {
    const related = await call('GET', `${V1}/cases/${caseB.id}/related`);
    const a = related.find((item) => item.case.id === caseA.id);
    assert(a, 'A missing');
    assert(a.sharedCount === 2, `sharedCount=${a.sharedCount}`);
    assert(Math.abs(a.ratio - 1) < 0.001, `ratio=${a.ratio}`);
    return `${a.sharedCount} shared`;
  });

  await test('similar(D) lists A (2/2) and B (1/2), not C', async () => {
    const similar = await call('GET', `${V1}/alerts/${alertD.id}/similar`);
    const ids = (similar.cases || []).map((item) => item.case.id);
    assert(ids.includes(caseA.id) && ids.includes(caseB.id), `cases=${JSON.stringify(ids)}`);
    assert(!ids.includes(caseC.id), 'unrelated C listed');
    assert(!ids.includes(caseE.id), 'ignoreSimilarity case E listed');
    const a = similar.cases.find((item) => item.case.id === caseA.id);
    const b = similar.cases.find((item) => item.case.id === caseB.id);
    assert(a.sharedCount === 2 && a.observableCount === 2, `A=${a.sharedCount}/${a.observableCount}`);
    assert(b.sharedCount === 1 && b.observableCount === 2, `B=${b.sharedCount}/${b.observableCount}`);
    assert(Array.isArray(similar.alerts), 'alerts is not an array');
    return `A ${a.sharedCount}/${a.observableCount}, B ${b.sharedCount}/${b.observableCount}`;
  });

  await test('sightings(ip X in A) lists B and D', async () => {
    const detail = await call('GET', `${V1}/cases/${caseA.id}`);
    const observable = (detail.observables || []).find((item) => item.dataType === 'ip' && item.data === IP);
    assert(observable, 'ip X not found in A');
    const sightings = await call('GET', `${V1}/observables/${observable.id}/sightings`);
    assert(sightings.some((item) => item.kind === 'case' && item.id === caseB.id), `B missing: ${JSON.stringify(sightings)}`);
    assert(sightings.some((item) => item.kind === 'alert' && item.id === alertD.id), 'D missing');
    assert(!sightings.some((item) => item.kind === 'case' && item.id === caseE.id), 'ignoreSimilarity E listed');
    return `${sightings.length} sighting(s)`;
  });

  await test("seenCount on A's ip X is 2", async () => {
    const detail = await call('GET', `${V1}/cases/${caseA.id}`);
    const observable = (detail.observables || []).find((item) => item.dataType === 'ip' && item.data === IP);
    assert(observable?.seenCount === 2, `seenCount=${observable?.seenCount}`);
    return `seenCount=${observable.seenCount}`;
  });

  await test('alert list exposes similarCaseCount in batch', async () => {
    // Fetch a page that includes our alert and look it up.
    const page = await call('GET', `${V1}/alerts?search=${encodeURIComponent(stamp)}&pageSize=50`);
    const item = (page.items || []).find((alert) => alert.id === alertD.id);
    assert(item, 'alert D missing from list');
    assert(item.similarCaseCount === 2, `similarCaseCount=${item.similarCaseCount}`);
    return `similarCaseCount=${item.similarCaseCount}`;
  });

  await test('merge D into A via the similar-case flow', async () => {
    const merged = await call('POST', `${V1}/alerts/${alertD.id}/merge/${caseA.id}`);
    assert(merged.id === caseA.id, `merged case=${merged.id}`);
    const alert = await call('GET', `${V1}/alerts/${alertD.id}`);
    assert(alert.caseId === caseA.id, `alert.caseId=${alert.caseId}`);
    return `merged into #${caseA.number}`;
  });

  await test('Query API similarCases from D returns A and B with counters', async () => {
    const result = await call('POST', `${V1}/query`, { query: [{ _name: 'getAlert', idOrName: alertD.id }, { _name: 'similarCases' }] });
    assert(Array.isArray(result), 'not an array');
    const ids = result.map((item) => item._id);
    assert(ids.includes(caseA.id) && ids.includes(caseB.id), `ids=${JSON.stringify(ids)}`);
    assert(!ids.includes(caseC.id), 'unrelated C listed');
    const a = result.find((item) => item._id === caseA.id);
    const b = result.find((item) => item._id === caseB.id);
    assert(a?._type === 'Case' && b?._type === 'Case', '_type is not Case');
    assert(a?.extraData?.similarObservableCount === 2, `A similarObservableCount=${a?.extraData?.similarObservableCount}`);
    assert(a?.extraData?.observableCount === 2, `A observableCount=${a?.extraData?.observableCount}`);
    assert(b?.extraData?.similarObservableCount === 1, `B similarObservableCount=${b?.extraData?.similarObservableCount}`);
    assert(typeof a?.extraData?.similarIocCount === 'number', 'missing similarIocCount');
    return `A ${a.extraData.similarObservableCount}/${a.extraData.observableCount}, B ${b.extraData.similarObservableCount}/${b.extraData.observableCount}`;
  });

  await test('TheHive 4 case links returns B', async () => {
    const links = await call('GET', `${API}/case/${caseA.id}/links`);
    assert(Array.isArray(links), 'not an array');
    assert(links.some((item) => item.id === caseB.id), `B missing: ${JSON.stringify(links.map((item) => item.id))}`);
    const b = links.find((item) => item.id === caseB.id);
    assert(Array.isArray(b.linkedWith) && b.linkedWith.length === 2, `linkedWith=${b.linkedWith?.length}`);
    assert(b._type === 'case', `_type=${b._type}`);
    return `${links.length} linked case(s)`;
  });
} finally {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
