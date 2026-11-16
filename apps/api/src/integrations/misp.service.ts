import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/decorators/auth.decorators';
import { Connector, ConnectorsService } from './connectors.service';
import { ExternalServiceError, httpJson, joinUrl } from './http-client';
import { AttachmentsService } from '../attachments/attachments.service';

interface SyncScope {
  organisationId: string;
  actorId: string | null;
}

export interface SyncOptions {
  last?: string;
  limit?: number;
  publishedOnly?: boolean;
  tags?: string[];
}

const TLP_TAGS: Record<string, number> = { 'tlp:white': 0, 'tlp:clear': 0, 'tlp:green': 1, 'tlp:amber': 2, 'tlp:amber+strict': 2, 'tlp:red': 3 };
const TLP_NAMES = ['tlp:white', 'tlp:green', 'tlp:amber', 'tlp:red'];

/** MISP attribute type → MyHive observable dataType. */
function mispTypeToDataType(type: string): string {
  const t = type.toLowerCase();
  if (t.startsWith('ip-src') || t.startsWith('ip-dst')) return 'ip';
  if (t === 'domain' || t === 'domain|ip') return 'domain';
  if (t === 'hostname' || t === 'hostname|port') return 'fqdn';
  if (t === 'url' || t === 'link') return 'url';
  if (t === 'uri') return 'uri_path';
  if (['email', 'email-src', 'email-dst', 'target-email', 'email-reply-to', 'whois-registrant-email'].includes(t)) return 'mail';
  if (t === 'email-subject') return 'mail_subject';
  if (['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'ssdeep', 'imphash', 'tlsh', 'authentihash', 'pehash', 'vhash'].includes(t)) return 'hash';
  if (t.startsWith('filename|')) return 'hash';
  if (t === 'filename') return 'filename';
  if (t === 'regkey' || t === 'regkey|value') return 'registry';
  if (t === 'attachment' || t === 'malware-sample') return 'file';
  if (t === 'user-agent') return 'user-agent';
  if (t === 'as') return 'autonomous-system';
  return 'other';
}

/** Normalises composite MISP values ("1.2.3.4|443", "file.exe|<md5>") to the useful part. */
function mispValue(type: string, value: string): string {
  const t = type.toLowerCase();
  if (!value.includes('|')) return value;
  const [left, right] = value.split('|');
  if (t.startsWith('filename|')) return right;
  if (t === 'ip-src|port' || t === 'ip-dst|port' || t === 'hostname|port' || t === 'domain|ip' || t === 'regkey|value') return left;
  return value;
}

/** MyHive observable → MISP attribute type/category. */
function toMispAttribute(dataType: string, data: string): { type: string; category: string } {
  switch (dataType) {
    case 'ip': return { type: 'ip-dst', category: 'Network activity' };
    case 'domain': return { type: 'domain', category: 'Network activity' };
    case 'fqdn': return { type: 'hostname', category: 'Network activity' };
    case 'url': return { type: 'url', category: 'Network activity' };
    case 'uri_path': return { type: 'uri', category: 'Network activity' };
    case 'user-agent': return { type: 'user-agent', category: 'Network activity' };
    case 'autonomous-system': return { type: 'AS', category: 'Network activity' };
    case 'mail': return { type: 'email-src', category: 'Payload delivery' };
    case 'mail_subject': return { type: 'email-subject', category: 'Payload delivery' };
    case 'filename': return { type: 'filename', category: 'Payload delivery' };
    case 'registry': return { type: 'regkey', category: 'Persistence mechanism' };
    case 'hash': {
      const len = data.trim().length;
      const type = len === 32 ? 'md5' : len === 40 ? 'sha1' : len === 64 ? 'sha256' : len === 128 ? 'sha512' : 'ssdeep';
      return { type, category: 'Payload delivery' };
    }
    default: return { type: 'text', category: 'Other' };
  }
}

const hashOf = (dataType: string, data: string) => createHash('sha256').update(`${dataType}:${data.toLowerCase()}`).digest('hex');

@Injectable()
export class MispService {
  private readonly logger = new Logger(MispService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
  ) {}

  // ------------------------------------------------------------ import (MISP → alerts)

  async syncForUser(user: AuthUser, body: any) {
    const server = await this.connectors.first(user, 'misp', body?.connectorId);
    const result = await this.syncEvents(server, { organisationId: user.organisationId, actorId: user.id }, this.parseOptions(body));
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'misp-sync', objectType: 'alert', details: { connector: server.name, ...result, alerts: undefined } });
    return result;
  }

  parseOptions(body: any): SyncOptions {
    const last = String(body?.last || '7d');
    if (!/^\d+[mhdw]$/.test(last)) throw new BadRequestException('last must look like 30m, 12h, 7d or 2w');
    return {
      last,
      limit: Math.min(500, Math.max(1, Number(body?.limit ?? 100))),
      publishedOnly: !!body?.publishedOnly,
      tags: Array.isArray(body?.tags) ? body.tags.filter(Boolean).map(String) : undefined,
    };
  }

  async syncEvents(server: Connector, scope: SyncScope, options: SyncOptions) {
    // `timestamp` = last modification (`last` would only match *published* events).
    // Events exported by MyHive itself carry the "myhive" tag and are skipped to avoid import loops.
    const search: any = {
      returnFormat: 'json',
      timestamp: options.last || '7d',
      limit: options.limit || 100,
      page: 1,
      includeEventTags: true,
      tags: [...(options.tags || []), '!myhive'],
    };
    if (options.publishedOnly) search.published = true;
    const res = await this.call(server, 'POST', '/events/restSearch', search);
    const events: any[] = (res?.response || []).map((e: any) => e.Event || e).filter(Boolean);

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let observablesAdded = 0;
    const errors: string[] = [];
    const alerts: string[] = [];
    for (const event of events) {
      try {
        const r = await this.upsertAlertFromEvent(server, scope, event);
        if (r.created) created++;
        else if (r.updated) updated++;
        else unchanged++;
        observablesAdded += r.observablesAdded;
        alerts.push(r.alertId);
      } catch (e: any) {
        errors.push(`event ${event?.id}: ${e.message}`);
      }
    }
    return { events: events.length, created, updated, unchanged, observablesAdded, errors, alerts };
  }

  private async upsertAlertFromEvent(server: Connector, scope: SyncScope, event: any) {
    const tags: string[] = (event.Tag || []).map((t: any) => String(t.name));
    const tlpTag = tags.find((t) => TLP_TAGS[t.toLowerCase()] !== undefined);
    const tlp = tlpTag ? TLP_TAGS[tlpTag.toLowerCase()] : 2;
    const severity = ({ '1': 3, '2': 2, '3': 1, '4': 2 } as Record<string, number>)[String(event.threat_level_id)] ?? 2;
    const attributes: any[] = [
      ...(event.Attribute || []),
      ...((event.Object || []) as any[]).flatMap((o: any) => (o.Attribute || []).map((a: any) => ({ ...a, objectName: o.name }))),
    ].filter((a) => !a.deleted);
    const link = joinUrl(server.config.url, `/events/view/${event.id}`);
    const description = [
      `**Evento MISP #${event.id}** — ${event.Orgc?.name || event.Org?.name || 'Org desconocida'}`,
      '',
      `- Fecha: ${event.date || '—'}`,
      `- Publicado: ${event.published ? 'sí' : 'no'}`,
      `- Análisis: ${['Inicial', 'En curso', 'Completado'][Number(event.analysis)] || event.analysis}`,
      `- Atributos: ${attributes.length}`,
      '',
      `[Abrir en MISP](${link})`,
    ].join('\n');

    const key = { organisationId: scope.organisationId, type: 'misp', source: server.name, sourceRef: String(event.uuid || event.id) };
    const existing = await this.prisma.alert.findUnique({ where: { organisationId_type_source_sourceRef: key }, include: { observables: { select: { dataHash: true } } } });
    const status = await this.prisma.alertStatus.findFirst({ where: { organisationId: scope.organisationId, value: 'New' } });

    const base = {
      title: String(event.info || `MISP event ${event.id}`).slice(0, 500),
      description,
      severity,
      tlp,
      pap: 2,
      tags,
      externalLink: link,
      date: event.timestamp ? new Date(Number(event.timestamp) * 1000) : event.date ? new Date(event.date) : new Date(),
      customFields: { mispEventId: String(event.id), mispEventUuid: event.uuid, mispTimestamp: String(event.timestamp || '') } as any,
    };

    const knownHashes = new Set((existing?.observables || []).map((o) => o.dataHash));
    const newObservables: any[] = [];
    const fileAttributes: any[] = [];
    for (const a of attributes) {
      if (!a?.value || !a?.type) continue;
      if (a.type === 'malware-sample' || a.type === 'attachment') {
        fileAttributes.push(a);
        continue;
      }
      const dataType = mispTypeToDataType(a.type);
      const data = mispValue(a.type, String(a.value));
      const dataHash = hashOf(dataType, data);
      if (knownHashes.has(dataHash)) continue;
      knownHashes.add(dataHash);
      newObservables.push({
        organisationId: scope.organisationId,
        dataType,
        data,
        dataHash,
        message: [a.category, a.objectName, a.comment].filter(Boolean).join(' · ') || a.type,
        tlp,
        pap: 2,
        ioc: !!a.to_ids,
        tags: [`misp:type=${a.type}`, ...((a.Tag || []) as any[]).map((t) => String(t.name))],
        createdById: scope.actorId,
      });
    }

    let alertId: string;
    let created = false;
    if (!existing) {
      const alert = await this.prisma.alert.create({
        data: {
          ...key,
          ...base,
          statusId: status?.id,
          stage: status?.stage || 'New',
          createdById: scope.actorId,
          observables: { create: newObservables.map(({ organisationId, ...o }) => ({ ...o, organisationId })) },
        },
      });
      alertId = alert.id;
      created = true;
    } else {
      alertId = existing.id;
      if (newObservables.length) {
        await this.prisma.observable.createMany({
          data: newObservables.map((o) => ({ ...o, alertId: existing.caseId ? null : existing.id, caseId: existing.caseId || null })),
        });
      }
    }

    let filesAdded = 0;
    for (const attribute of fileAttributes) {
      try {
        const added = await this.importMispFile(server, scope, alertId, attribute, tlp, knownHashes, existing?.caseId || null);
        if (added) filesAdded++;
      } catch {
        // A single unreadable attachment must not abort the whole event import.
      }
    }

    if (!created) {
      const previousTs = (existing.customFields as any)?.mispTimestamp;
      const changed = String(event.timestamp || '') !== String(previousTs || '') || newObservables.length > 0 || filesAdded > 0;
      if (!changed) return { created: false, updated: false, alertId, observablesAdded: 0 };
      await this.prisma.alert.update({ where: { id: alertId }, data: { ...base, read: false } });
    }
    return { created, updated: !created, alertId, observablesAdded: newObservables.length + filesAdded };
  }

  /** Stores a MISP attachment/malware-sample attribute as a file observable (+ attachment on disk). */
  private async importMispFile(
    server: Connector,
    scope: SyncScope,
    alertId: string,
    attribute: any,
    tlp: number,
    knownHashes: Set<string>,
    caseId: string | null,
  ) {
    let buffer: Buffer;
    if (attribute.data) {
      buffer = Buffer.from(String(attribute.data).replace(/\s/g, ''), 'base64');
    } else if (attribute.id) {
      buffer = await this.downloadMispAttribute(server, attribute.id);
    } else {
      return false;
    }
    if (!buffer?.length) return false;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (knownHashes.has(sha256)) return false;
    knownHashes.add(sha256);
    const filename = attribute.type === 'malware-sample'
      ? String(attribute.value).split('|')[0]
      : String(attribute.value);
    const observable = await this.prisma.observable.create({
      data: {
        organisationId: scope.organisationId,
        alertId: caseId ? null : alertId,
        caseId,
        dataType: 'file',
        data: filename,
        dataHash: sha256,
        message: [attribute.category, attribute.objectName, attribute.comment].filter(Boolean).join(' · ') || attribute.type,
        tlp,
        pap: 2,
        ioc: !!attribute.to_ids,
        tags: [`misp:type=${attribute.type}`, ...((attribute.Tag || []) as any[]).map((t) => String(t.name))],
        createdById: scope.actorId,
      },
    });
    const attachment = await this.attachments.upload(
      { organisationId: scope.organisationId, id: scope.actorId },
      { originalname: filename, mimetype: 'application/octet-stream', size: buffer.length, buffer },
      { objectType: 'observable', objectId: observable.id },
    );
    await this.prisma.observable.update({ where: { id: observable.id }, data: { attachmentId: attachment.id } });
    return true;
  }

  private async downloadMispAttribute(server: Connector, attributeId: string) {
    const res = await httpJson(joinUrl(server.config.url, `/attributes/download/${encodeURIComponent(attributeId)}`), {
      headers: { ...this.connectors.authHeaders(server) },
      insecure: server.config.verifyTls === false,
      timeoutMs: 60000,
    });
    if (!res.ok || !res.buffer) {
      throw new ExternalServiceError(`MISP ${server.name}: HTTP ${res.status} downloading attachment`, res.status, res.data);
    }
    return res.buffer;
  }

  // ------------------------------------------------------------ export (case → MISP event)

  async exportCase(user: AuthUser, caseId: string, body: any) {
    const server = await this.connectors.first(user, 'misp', body?.connectorId);
    const c = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId }, include: { observables: { include: { attachment: true } } } });
    if (!c) throw new NotFoundException('Case not found');
    const observables = body?.iocOnly ? c.observables.filter((o) => o.ioc) : c.observables;
    const exports: any[] = Array.isArray(c.exports) ? (c.exports as any[]) : [];
    const previous = exports.find((e) => e.type === 'misp' && e.connectorId === server.id);

    let eventId: string | null = previous?.eventId || null;
    let existingValues = new Set<string>();
    if (eventId) {
      try {
        const current = await this.call(server, 'GET', `/events/view/${eventId}`);
        const ev = current?.Event || current;
        existingValues = new Set(((ev?.Attribute || []) as any[]).map((a) => `${a.type}:${String(a.value).toLowerCase()}`));
      } catch (e) {
        if (e instanceof ExternalServiceError && (e.status === 404 || e.status === 403)) eventId = null;
        else throw e;
      }
    }

    const attributes: any[] = [];
    const seenAttributes = new Set<string>();
    const addAttribute = (attribute: any) => {
      const key = `${attribute.type}:${String(attribute.value).toLowerCase()}`;
      if (seenAttributes.has(key)) return;
      seenAttributes.add(key);
      attributes.push(attribute);
    };
    for (const o of observables) {
      const comment = o.message || `Nuestracolmena case #${c.number}`;
      if (o.dataType === 'file' && o.attachment) {
        try {
          const { path } = await this.attachments.getForDownload(o.attachment.id);
          const buffer = await fs.readFile(path);
          const md5 = createHash('md5').update(buffer).digest('hex');
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          addAttribute({
            type: o.ioc ? 'malware-sample' : 'attachment',
            category: 'Payload delivery',
            value: o.ioc ? `${o.attachment.filename}|${md5}` : o.attachment.filename,
            data: buffer.toString('base64'),
            to_ids: o.ioc,
            comment,
            distribution: 5,
          });
          addAttribute({ type: 'sha256', category: 'Payload delivery', value: sha256, to_ids: o.ioc, comment, distribution: 5 });
          addAttribute({ type: 'md5', category: 'Payload delivery', value: md5, to_ids: o.ioc, comment, distribution: 5 });
          continue;
        } catch {
          // If the stored file is unreadable, fall back to exporting the filename as a plain attribute.
        }
      }
      const { type, category } = toMispAttribute(o.dataType, o.data);
      addAttribute({ type, category, value: o.data, to_ids: o.ioc, comment, distribution: 5 });
    }

    const tags = [...new Set([TLP_NAMES[c.tlp] || 'tlp:amber', ...c.tags, 'myhive'])].map((name) => ({ name }));
    let added = 0;
    if (!eventId) {
      const threat = c.severity >= 3 ? 1 : c.severity === 2 ? 2 : 3;
      const created = await this.call(server, 'POST', '/events/add', {
        Event: {
          info: `[Nuestracolmena #${c.number}] ${c.title}`,
          date: c.startDate.toISOString().slice(0, 10),
          distribution: server.config.distribution ?? 0,
          threat_level_id: threat,
          analysis: c.stage === 'Closed' ? 2 : 1,
          Attribute: attributes,
          Tag: tags,
        },
      });
      const ev = created?.Event || created;
      if (!ev?.id) throw new BadRequestException(`MISP did not return an event: ${JSON.stringify(created).slice(0, 300)}`);
      eventId = String(ev.id);
      added = attributes.length;
      exports.splice(exports.indexOf(previous), previous ? 1 : 0);
      exports.push({ type: 'misp', connectorId: server.id, connectorName: server.name, eventId, eventUuid: ev.uuid, exportedAt: new Date().toISOString(), attributes: added });
    } else {
      for (const attr of attributes) {
        if (existingValues.has(`${attr.type}:${attr.value.toLowerCase()}`)) continue;
        await this.call(server, 'POST', `/attributes/add/${eventId}`, attr);
        added++;
      }
      for (const tag of tags) {
        await this.call(server, 'POST', `/events/addTag/${eventId}/${encodeURIComponent(tag.name)}/local:0`, {}).catch(() => undefined);
      }
      previous.exportedAt = new Date().toISOString();
      previous.attributes = (previous.attributes || 0) + added;
    }

    await this.prisma.case.update({ where: { id: c.id }, data: { exports: exports as any } });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'misp-export', objectType: 'case', objectId: c.id, details: { connector: server.name, eventId, added } });
    return {
      eventId,
      url: joinUrl(server.config.url, `/events/view/${eventId}`),
      attributesAdded: added,
      updated: !!previous && previous.eventId === eventId,
      attributes: attributes.map(({ type, value }) => ({ type, value })),
      exports,
    };
  }

  /** Deletes a MISP event (used to clean up test exports). */
  async deleteEvent(user: AuthUser, eventId: string, body: any) {
    const server = await this.connectors.first(user, 'misp', body?.connectorId);
    await this.call(server, 'POST', `/events/delete/${encodeURIComponent(eventId)}`, {});
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'misp-delete-event', objectType: 'case', details: { connector: server.name, eventId } });
    return { ok: true, eventId };
  }

  // ------------------------------------------------------------ lookup (observable → MISP)

  async searchObservable(user: AuthUser, observableId: string, body: any) {
    const observable = await this.prisma.observable.findFirst({ where: { id: observableId, organisationId: user.organisationId } });
    if (!observable) throw new NotFoundException('Observable not found');
    const servers = body?.connectorId ? [await this.connectors.get(user, body.connectorId, 'misp')] : await this.connectors.list(user, 'misp');
    if (!servers.length) throw new BadRequestException('No MISP server configured');
    const results: any[] = [];
    for (const server of servers) {
      try {
        const res = await this.call(server, 'POST', '/attributes/restSearch', { returnFormat: 'json', value: observable.data, limit: 50, includeEventTags: true, includeContext: true });
        const attrs: any[] = res?.response?.Attribute || [];
        results.push({
          connectorId: server.id,
          connectorName: server.name,
          hits: attrs.map((a) => ({
            eventId: a.event_id,
            eventInfo: a.Event?.info,
            eventDate: a.Event?.date,
            org: a.Event?.Orgc?.name || a.Event?.Org?.name,
            type: a.type,
            category: a.category,
            value: a.value,
            toIds: a.to_ids,
            comment: a.comment,
            url: joinUrl(server.config.url, `/events/view/${a.event_id}`),
          })),
        });
      } catch (e: any) {
        results.push({ connectorId: server.id, connectorName: server.name, error: e.message, hits: [] });
      }
    }
    const total = results.reduce((n, r) => n + r.hits.length, 0);
    if (total > 0 && !observable.sighted) {
      await this.prisma.observable.update({
        where: { id: observable.id },
        data: { sighted: true, sightedAt: new Date(), tags: Array.from(new Set([...observable.tags, 'misp:hit'])) },
      });
    }
    return { observable: { id: observable.id, dataType: observable.dataType, data: observable.data }, total, results };
  }

  // ------------------------------------------------------------ helpers

  async call(server: Connector, method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await httpJson(joinUrl(server.config.url, path), {
      method,
      body,
      headers: { ...this.connectors.authHeaders(server), Accept: 'application/json' },
      insecure: server.config.verifyTls === false,
      timeoutMs: 60000,
    });
    if (!res.ok) {
      const detail = typeof res.data === 'object' ? res.data?.message || res.data?.errors || res.data?.name || JSON.stringify(res.data) : res.text;
      throw new ExternalServiceError(`MISP ${server.name}: HTTP ${res.status} ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`, res.status, res.data);
    }
    return res.data;
  }
}
