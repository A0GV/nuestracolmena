import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { HiveEvent } from '../events/events.module';
import { mapModel } from '../compat/thehive-mapper';
import { MASK } from './automation.constants';

const MODEL_BY_TYPE: Record<string, string> = {
  Alert: 'alert',
  Case: 'case',
  Task: 'caseTask',
  Log: 'taskLog',
  Observable: 'observable',
  Comment: 'comment',
  Page: 'page',
  Procedure: 'procedure',
  Attachment: 'attachment',
  Job: 'job',
};

const VERBS: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  'force-delete': 'deleted',
  close: 'closed',
  reopen: 'reopened',
  merge: 'merged',
  'merge-alert': 'merged',
  'import-to-case': 'imported',
  finish: 'finished',
};

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
  transport?: string;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger('Notifications');

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- object/context loading

  private modelName(objectType: string) {
    return MODEL_BY_TYPE[objectType] || objectType;
  }

  private async loadRawObject(event: HiveEvent): Promise<any> {
    if (event.object) return event.object;
    const id = event.objectId;
    if (!id) return null;
    switch (event.objectType) {
      case 'Alert':
        return this.prisma.alert.findUnique({
          where: { id },
          include: { status: true, assignee: true, createdBy: true, case: true, observables: true, procedures: true },
        });
      case 'Case':
        return this.prisma.case.findUnique({
          where: { id },
          include: { status: true, assignee: true, createdBy: true, tasks: true, observables: true, procedures: true, alerts: true },
        });
      case 'Task':
        return this.prisma.caseTask.findUnique({ where: { id }, include: { assignee: true, case: true, logs: true } });
      case 'Log':
        return this.prisma.taskLog.findUnique({ where: { id }, include: { createdBy: true, task: true } });
      case 'Observable':
        return this.prisma.observable.findUnique({ where: { id }, include: { createdBy: true, case: true } });
      case 'Comment':
        return this.prisma.comment.findUnique({ where: { id }, include: { createdBy: true } });
      case 'Page':
        return this.prisma.page.findUnique({ where: { id }, include: { createdBy: true, case: true } });
      case 'Procedure':
        return this.prisma.procedure.findUnique({ where: { id }, include: { createdBy: true } });
      case 'Attachment':
        return this.prisma.attachment.findUnique({ where: { id }, include: { createdBy: true } });
      case 'Job':
        return this.prisma.job.findUnique({ where: { id } });
      default:
        return null;
    }
  }

  private async loadRoot(rootId: string | null | undefined, rootType: string | null | undefined): Promise<any> {
    if (!rootId) return null;
    const type = String(rootType || '').toLowerCase();
    if (type === 'alert') {
      return this.prisma.alert.findUnique({
        where: { id: rootId },
        include: { status: true, assignee: true, createdBy: true, case: true, observables: true, procedures: true },
      });
    }
    if (type === 'case') {
      return this.prisma.case.findUnique({
        where: { id: rootId },
        include: { status: true, assignee: true, createdBy: true, tasks: true, observables: true, procedures: true, alerts: true },
      });
    }
    const asCase = await this.prisma.case.findUnique({
      where: { id: rootId },
      include: { status: true, assignee: true, createdBy: true, tasks: true, observables: true, procedures: true, alerts: true },
    });
    if (asCase) return asCase;
    return this.prisma.alert.findUnique({
      where: { id: rootId },
      include: { status: true, assignee: true, createdBy: true, case: true, observables: true, procedures: true },
    });
  }

  private deriveRoot(rawObject: any, event: HiveEvent) {
    if (event.rootId) {
      const type = String(event.rootType || '').toLowerCase();
      return { rootId: event.rootId, rootType: type === 'alert' ? 'Alert' : type === 'case' ? 'Case' : event.rootType || null };
    }
    if (!rawObject) return { rootId: null, rootType: null };
    if (event.objectType === 'Case') return { rootId: rawObject.id, rootType: 'Case' };
    if (event.objectType === 'Alert') return { rootId: rawObject.id, rootType: 'Alert' };
    if (rawObject.caseId) return { rootId: rawObject.caseId, rootType: 'Case' };
    if (rawObject.alertId) return { rootId: rawObject.alertId, rootType: 'Alert' };
    return { rootId: null, rootType: null };
  }

  async buildScope(event: HiveEvent, organisation: string) {
    const rawObject = await this.loadRawObject(event);
    const { rootId, rootType } = this.deriveRoot(rawObject, event);
    const rawContext =
      event.context ??
      ((event.objectType === 'Case' || event.objectType === 'Alert') && rawObject
        ? rawObject
        : await this.loadRoot(rootId, rootType));
    const mappedObject = rawObject ? mapModel(this.modelName(event.objectType), rawObject) : null;
    const contextType =
      event.objectType === 'Case' || event.objectType === 'Alert'
        ? event.objectType
        : rootType || (rawContext?.number !== undefined ? 'Case' : rawContext?.sourceRef ? 'Alert' : 'Case');
    const mappedContext = rawContext ? mapModel(this.modelName(contextType), rawContext) : null;
    return {
      rawObject,
      rawContext,
      object: mappedObject,
      context: rawContext,
      rootId,
      rootType,
      scope: {
        event: { ...event, date: event.date.toISOString(), object: undefined, context: undefined },
        object: mappedObject,
        context: mappedContext,
        organisation,
        url: this.buildUrl(event, rootId, rootType),
      },
    };
  }

  private buildUrl(event: HiveEvent, rootId: string | null, rootType: string | null) {
    const base = (process.env.PUBLIC_URL || 'http://localhost:8088').replace(/\/+$/, '');
    if (event.objectType === 'Case' && event.objectId) return `${base}/cases/${event.objectId}`;
    if (event.objectType === 'Alert' && event.objectId) return `${base}/alerts?alert=${event.objectId}`;
    if (String(rootType || '').toLowerCase() === 'alert' && rootId) return `${base}/alerts?alert=${rootId}`;
    if (rootId) return `${base}/cases/${rootId}`;
    return base;
  }

  // ---------------------------------------------------------------- templates

  renderTemplate(template: string, scope: any): string {
    return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
      const value = path.split('.').reduce((acc: any, key: string) => (acc === null || acc === undefined ? undefined : acc[key]), scope);
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });
  }

  defaultSummary(event: HiveEvent, object: any): string {
    const verb = VERBS[event.action] || event.action;
    if (event.objectType === 'Case') {
      const number = object?.number ? `#${object.number} ` : '';
      return `[Nuestracolmena] Case ${number}${verb}${object?.title ? `: ${object.title}` : ''}`;
    }
    if (event.objectType === 'Alert') {
      return `[Nuestracolmena] Alert ${verb}${object?.title ? `: ${object.title}` : ''}`;
    }
    const title = object?.title || object?.message || object?.data || object?.name;
    return `[Nuestracolmena] ${event.objectType} ${verb}${title ? `: ${title}` : ''}`;
  }

  defaultEmailBody(event: HiveEvent, object: any, scope: any): string {
    const lines = [
      this.defaultSummary(event, object),
      '',
      `Acción: ${event.action}`,
      `Objeto: ${event.objectType} ${event.objectId || ''}`.trim(),
    ];
    if (object?.title) lines.push(`Título: ${object.title}`);
    if (object?.severity !== undefined) lines.push(`Severidad: ${object.severity}`);
    if (object?.status) lines.push(`Estado: ${typeof object.status === 'object' ? object.status.value : object.status}`);
    if (object?.tags?.length) lines.push(`Tags: ${object.tags.join(', ')}`);
    lines.push('', `Enlace: ${scope.url}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- delivery

  async deliver(options: {
    notification: any;
    notifier: any;
    endpoint: any;
    event: HiveEvent;
    organisation: string;
    test?: boolean;
  }): Promise<DeliveryResult> {
    const { notification, notifier, endpoint, event, organisation, test = false } = options;
    const built = await this.buildScope(event, organisation);
    const scope = built.scope;
    let lastError = 'Unknown error';
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const startedAt = new Date();
      let outcome: { ok: boolean; status?: number; error?: string; transport?: string };
      try {
        outcome = await this.sendOnce(notifier, endpoint, event, scope, built);
      } catch (e: any) {
        outcome = { ok: false, error: e?.message || String(e) };
      }
      lastError = outcome.error || lastError;
      lastStatus = outcome.status ?? lastStatus;

      try {
        await this.prisma.job.create({
          data: {
            organisationId: event.organisationId,
            type: 'notification',
            status: outcome.ok ? 'Success' : 'Failure',
            payload: {
              notificationId: notification.id,
              notificationName: notification.name,
              notifierType: notifier.type,
              endpointId: endpoint.id,
              endpointName: endpoint.name,
              event: {
                id: event.id,
                action: event.action,
                objectType: event.objectType,
                objectId: event.objectId,
                rootId: event.rootId,
              },
              attempt,
              test,
            },
            result: {
              attempt,
              httpStatus: outcome.status ?? null,
              error: outcome.error ?? null,
              transport: outcome.transport ?? null,
            },
            createdById: notification.createdById ?? null,
            startedAt,
            finishedAt: new Date(),
          },
        });
      } catch (e: any) {
        this.logger.warn(`Could not record notification delivery: ${e.message}`);
      }

      if (outcome.ok) return { ok: true, attempts: attempt, status: outcome.status, transport: outcome.transport };
      if (attempt < 3) await sleep(attempt === 1 ? 1000 : 5000);
    }
    return { ok: false, attempts: 3, status: lastStatus, error: lastError };
  }

  private async sendOnce(notifier: any, endpoint: any, event: HiveEvent, scope: any, built: any) {
    const config = endpoint.config || {};
    const type = notifier.type;

    if (type === 'webhook') {
      const format = config.format === 'raw' ? 'raw' : 'thehive';
      // TheHive 5 (and the n8n trigger) only knows create/update/delete.
      const webhookAction =
        event.action === 'create' ? 'create' : event.action === 'delete' || event.action === 'force-delete' ? 'delete' : 'update';
      const body =
        format === 'raw'
          ? { event: scope.event, object: built.rawObject ?? null }
          : {
              action: webhookAction,
              objectType: event.objectType,
              objectId: event.objectId,
              rootId: built.rootId,
              organisation: scope.organisation,
              organisationId: event.organisationId,
              requestId: event.id,
              details: { ...(event.details || {}), operation: event.action },
              object: scope.object,
              context: scope.context,
              _createdAt: event.date.getTime(),
              _createdBy: event.actorLogin ?? null,
            };
      const headers: Record<string, string> = { ...(config.headers || {}) };
      const auth = config.auth || {};
      if (auth.type === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
      if (auth.type === 'basic' && (auth.username || auth.password)) {
        headers.Authorization = `Basic ${Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64')}`;
      }
      const method = String(config.method || 'POST').toUpperCase();
      const res = await httpRequest(config.url, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
        timeoutMs: 10000,
        insecure: config.verifyTls === false,
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, error: res.status >= 200 && res.status < 300 ? undefined : `HTTP ${res.status}`, transport: 'http' };
    }

    if (type === 'slack' || type === 'mattermost' || type === 'teams' || type === 'discord') {
      const template = notifier.template || config.template;
      const text = template ? this.renderTemplate(template, scope) : `${this.defaultSummary(event, scope.object)}\n${scope.url}`;
      const payload =
        type === 'discord'
          ? { content: text }
          : type === 'teams'
            ? {
                '@type': 'MessageCard',
                '@context': 'http://schema.org/extensions',
                summary: this.defaultSummary(event, scope.object),
                text,
              }
            : { text };
      const res = await httpRequest(config.webhookUrl, {
        method: 'POST',
        headers: {},
        body: payload,
        timeoutMs: 10000,
        insecure: config.verifyTls === false,
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, error: res.status >= 200 && res.status < 300 ? undefined : `HTTP ${res.status}`, transport: 'http' };
    }

    if (type === 'email') {
      const template = notifier.template || config.template;
      const subject = notifier.subject
        ? this.renderTemplate(notifier.subject, scope)
        : this.defaultSummary(event, scope.object);
      const text = template ? this.renderTemplate(template, scope) : this.defaultEmailBody(event, scope.object, scope);
      const to = Array.isArray(notifier.to) ? notifier.to.filter(Boolean) : [];
      if (!to.length) throw new BadRequestException('email notifier requires at least one recipient');
      const info = await sendMail(config, { to, subject, text });
      return { ok: true, transport: 'smtp', status: undefined, error: undefined, ...info };
    }

    throw new BadRequestException(`Unknown notifier type: ${type}`);
  }

  // ---------------------------------------------------------------- endpoint probe

  async probeEndpoint(endpoint: any, body: any = {}) {
    const type = endpoint.type === 'smtp' ? 'email' : endpoint.type;
    const notifier: any = { type, endpointId: endpoint.id };
    if (type === 'email') {
      notifier.to = Array.isArray(body?.to) && body.to.length ? body.to : endpoint.config?.from ? [endpoint.config.from] : [];
    }
    const fakeId = randomUUID();
    const fake = {
      id: fakeId,
      number: 0,
      title: 'Nuestracolmena endpoint test',
      description: 'Synthetic event generated by the endpoint test',
      severity: 2,
      tlp: 2,
      pap: 2,
      tags: ['test'],
      status: 'New',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const event: HiveEvent = {
      id: randomUUID(),
      action: 'create',
      objectType: 'Case',
      objectId: fakeId,
      rootId: fakeId,
      rootType: 'Case',
      organisationId: endpoint.organisationId ?? null,
      actorId: null,
      actorLogin: null,
      details: { test: true },
      date: new Date(),
      object: fake,
    };
    const scope = await this.buildScope(event, endpoint.name || 'Nuestracolmena');
    try {
      const outcome = await this.sendOnce(notifier, endpoint, event, scope.scope, scope);
      return { ok: outcome.ok, status: outcome.status ?? null, error: outcome.error ?? null, transport: outcome.transport ?? null };
    } catch (e: any) {
      return { ok: false, status: null, error: e?.message || String(e), transport: null };
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: any; timeoutMs?: number; insecure?: boolean },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (payload !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const transport = isHttps ? https : http;
    const req = transport.request(
      parsed,
      {
        method: options.method || 'POST',
        headers,
        timeout: options.timeoutMs || 10000,
        ...(isHttps && options.insecure ? { rejectUnauthorized: false } : {}),
      } as any,
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (data.length < 20000) data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs || 10000}ms`));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function sendMail(config: any, message: { to: string[]; subject: string; text: string }) {
  const port = Number(config.port || (config.secure ? 465 : 25));
  const transporter = nodemailer.createTransport({
    host: config.host,
    port,
    secure: !!config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    tls: { rejectUnauthorized: config.verifyTls !== false },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  } as any);
  const info = await withTimeout(
    transporter.sendMail({
      from: config.from,
      to: message.to.join(', '),
      subject: message.subject,
      text: message.text,
    }),
    10000,
  );
  return { messageId: (info as any)?.messageId };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Recursively replaces secrets with a mask (API responses are write-only). */
export function maskSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== 'object') return value;
  const out: any = {};
  for (const [key, child] of Object.entries(value)) {
    if (MASK === child) out[key] = child;
    else if ((key === 'password' || key === 'token') && typeof child === 'string' && child) out[key] = MASK;
    else out[key] = maskSecrets(child);
  }
  return out;
}

/** Deep-merges an update over stored config, preserving masked/omitted secrets. */
export function mergeConfig(existing: any, incoming: any): any {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return existing ?? {};
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(incoming)) {
    if ((key === 'password' || key === 'token') && (value === undefined || value === null || value === '' || value === MASK)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      base[key] = mergeConfig(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}
