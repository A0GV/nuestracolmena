import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Accept self-signed certificates (typical for on-prem Cortex/MISP). */
  insecure?: boolean;
}

export interface HttpResponse<T = any> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
  /** Raw response body (needed for MISP attachment downloads). */
  buffer?: Buffer;
}

export interface MultipartFile {
  field: string;
  filename: string;
  contentType?: string;
  data: Buffer;
}

export interface MultipartOptions {
  method?: 'POST' | 'PATCH' | 'PUT';
  fields?: Record<string, string>;
  files?: MultipartFile[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  insecure?: boolean;
}

export class ExternalServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Minimal JSON HTTP client (no extra deps) with optional TLS verification bypass. */
export function httpJson<T = any>(url: string, options: HttpOptions = {}): Promise<HttpResponse<T>> {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const isBuffer = Buffer.isBuffer(options.body);
  const payload = options.body === undefined
    ? undefined
    : isBuffer
      ? (options.body as Buffer)
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(payload !== undefined
      ? { ...(isBuffer ? {} : { 'Content-Type': 'application/json' }), 'Content-Length': String(Buffer.byteLength(payload)) }
      : {}),
    ...(options.headers || {}),
  };
  const send = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: options.method || 'GET',
        headers,
        timeout: options.timeoutMs ?? 20000,
        ...(isHttps ? { rejectUnauthorized: !options.insecure } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let data: any = text;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            // keep raw text
          }
          const status = res.statusCode || 0;
          resolve({ status, ok: status >= 200 && status < 300, data, text, buffer });
        });
      },
    );
    req.on('timeout', () => req.destroy(new ExternalServiceError(`Timeout contacting ${target.host}`)));
    req.on('error', (err: any) =>
      reject(err instanceof ExternalServiceError ? err : new ExternalServiceError(`${target.host}: ${err.code || err.message}`)),
    );
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/** Sends multipart/form-data using Node's HTTP stack (keeps the same TLS/insecure handling as httpJson). */
export function httpMultipart<T = any>(url: string, options: MultipartOptions = {}): Promise<HttpResponse<T>> {
  const boundary = `----MyHive${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  const pushText = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
  const escape = (value: string) => value.replace(/"/g, '%22');

  for (const [name, value] of Object.entries(options.fields || {})) {
    pushText(`--${boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"\r\n\r\n${value}\r\n`);
  }
  for (const file of options.files || []) {
    pushText(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escape(file.field)}"; filename="${escape(file.filename)}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
    );
    chunks.push(file.data);
    pushText('\r\n');
  }
  pushText(`--${boundary}--\r\n`);

  return httpJson<T>(url, {
    method: options.method || 'POST',
    body: Buffer.concat(chunks),
    headers: { ...(options.headers || {}), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeoutMs: options.timeoutMs,
    insecure: options.insecure,
  });
}
