import { parentPort, workerData } from 'node:worker_threads';
import * as vm from 'node:vm';
import { inspect } from 'node:util';

const port = parentPort;
if (port) {
  const { code, input, user, organisation } = workerData as any;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  let sequence = 0;

  const post = (message: any) => {
    try {
      port.postMessage(message);
    } catch {
      // The parent may already have terminated the worker.
    }
  };

  port.on('message', (message: any) => {
    if (message?.type !== 'response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(String(message.error)));
    else request.resolve(message.value);
  });

  const format = (args: any[]) =>
    args.map((value) => (typeof value === 'string' ? value : inspect(value, { depth: 4, breakLength: 120 }))).join(' ');

  const log = (...args: any[]) => post({ type: 'log', line: format(args) });

  const rpc = (call: string, args: any[]) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      post({ type: 'call', id, call, args });
    });

  const request = async (options: any) => {
    const controller = new AbortController();
    const timeoutMs = Math.min(10000, Math.max(1, Number(options?.timeoutMs || 10000)));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const method = String(options?.method || 'GET').toUpperCase();
      const headers: Record<string, any> = { ...(options?.headers || {}) };
      let body: any;
      if (options?.body !== undefined) {
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(String(options.url), { method, headers, body, signal: controller.signal });
      const text = await response.text();
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Keep the raw body when it is not JSON.
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return { status: response.status, headers: responseHeaders, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  };

  const contextApi = {
    alert: {
      create: (body: any) => rpc('alert.create', [body]),
      get: (id: any) => rpc('alert.get', [id]),
      update: (id: any, patch: any) => rpc('alert.update', [id, patch]),
      find: (filter?: any) => rpc('alert.find', [filter]),
      createCase: (id: any, options?: any) => rpc('alert.createCase', [id, options]),
      merge: (id: any, caseId: any) => rpc('alert.merge', [id, caseId]),
    },
    case: {
      create: (body: any) => rpc('case.create', [body]),
      get: (idOrNumber: any) => rpc('case.get', [idOrNumber]),
      update: (id: any, patch: any) => rpc('case.update', [id, patch]),
      find: (filter?: any) => rpc('case.find', [filter]),
      addObservable: (caseId: any, observable: any) => rpc('case.addObservable', [caseId, observable]),
      addTask: (caseId: any, task: any) => rpc('case.addTask', [caseId, task]),
      addComment: (caseId: any, message: any) => rpc('case.addComment', [caseId, message]),
    },
    observable: {
      find: (filter?: any) => rpc('observable.find', [filter]),
    },
    query: (query: any) => rpc('query', [query]),
    http: { request },
    log,
    console: log,
    user,
    organisation,
  };

  const consoleApi = { log, info: log, warn: log, error: log, debug: log, trace: log };

  const sandbox: any = {
    console: consoleApi,
    __input: input,
    __context: contextApi,
    JSON,
    Math,
    Date,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    encodeURI,
    decodeURIComponent,
    decodeURI,
    atob,
    btoa,
  };

  const errorText = (error: any) => {
    const message = error?.message || String(error);
    const stack = String(error?.stack || '')
      .split('\n')
      .slice(0, 3)
      .join('\n');
    return stack ? `${message}\n${stack}` : message;
  };

  const safe = (value: any) => {
    try {
      const serialised = JSON.stringify(value);
      return serialised === undefined ? null : JSON.parse(serialised);
    } catch {
      return String(value);
    }
  };

  (async () => {
    try {
      const context = vm.createContext(sandbox, { name: 'myhive-function' });
      // Compilar y definir handle (1 s máximo).
      new vm.Script(String(code), { filename: 'function.js' }).runInContext(context, { timeout: 1000 });
      const exists = new vm.Script("typeof handle === 'function'").runInContext(context, { timeout: 1000 });
      if (!exists) throw new Error('The code must define function handle(input, context)');
      // La parte síncrona se interrumpe a los 30 s; el padre además termina el worker.
      const result = new vm.Script('handle(__input, __context)').runInContext(context, { timeout: 30000 });
      const value = await Promise.resolve(result);
      post({ type: 'result', output: safe(value) });
    } catch (error: any) {
      post({ type: 'error', error: errorText(error), timedOut: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
    }
  })();
}
