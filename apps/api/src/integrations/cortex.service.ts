import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/decorators/auth.decorators';
import { Connector, ConnectorsService } from './connectors.service';
import { ExternalServiceError, httpJson, httpMultipart, joinUrl } from './http-client';
import { AttachmentsService } from '../attachments/attachments.service';

const PENDING = ['Waiting', 'InProgress'];
const FINAL = ['Success', 'Failure', 'Deleted'];

export type ResponderTarget = 'case' | 'task' | 'observable' | 'alert';
const RESPONDER_DATATYPE: Record<ResponderTarget, string> = {
  case: 'thehive:case',
  task: 'thehive:case_task',
  observable: 'thehive:case_artifact',
  alert: 'thehive:alert',
};

@Injectable()
export class CortexService {
  private readonly logger = new Logger(CortexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
  ) {}

  // ---------------------------------------------------------------- analyzers

  async listAnalyzers(user: AuthUser, dataType?: string) {
    const servers = await this.connectors.list(user, 'cortex');
    const analyzers: any[] = [];
    const errors: any[] = [];
    for (const server of servers) {
      try {
        const path = dataType ? `/api/analyzer/type/${encodeURIComponent(dataType)}` : '/api/analyzer?range=all';
        const list = await this.call(server, 'GET', path);
        for (const a of Array.isArray(list) ? list : []) {
          analyzers.push({
            connectorId: server.id,
            connectorName: server.name,
            id: a.id,
            name: a.name,
            version: a.version,
            description: a.description,
            dataTypeList: a.dataTypeList || [],
          });
        }
      } catch (e: any) {
        errors.push({ connectorId: server.id, connectorName: server.name, error: e.message });
      }
    }
    analyzers.sort((a, b) => a.name.localeCompare(b.name));
    return { analyzers, errors, servers: servers.length };
  }

  async runAnalyzers(user: AuthUser, observableId: string, body: any) {
    const observable = await this.loadObservable(user, observableId);
    let requested: { connectorId: string; analyzerId: string }[] = Array.isArray(body?.analyzers) ? body.analyzers : [];
    if (body?.all) {
      const { analyzers } = await this.listAnalyzers(user, observable.dataType);
      requested = analyzers.map((a) => ({ connectorId: a.connectorId, analyzerId: a.id }));
    }
    if (!requested.length) throw new BadRequestException('Select at least one analyzer');

    const context = observable.case ? `Nuestracolmena case #${observable.case.number}` : observable.alert ? `Nuestracolmena alert ${observable.alert.title}` : 'Nuestracolmena';
    const created: any[] = [];
    const errors: any[] = [];
    for (const item of requested) {
      try {
        const server = await this.connectors.get(user, item.connectorId, 'cortex');
        let job: any;
        if (observable.dataType === 'file' && observable.attachment) {
          const { path } = await this.attachments.getForDownload(observable.attachment.id);
          const buffer = await fs.readFile(path);
          job = await this.callMultipart(server, `/api/analyzer/${encodeURIComponent(item.analyzerId)}/run`, {
            _json: JSON.stringify({
              dataType: 'file',
              tlp: observable.tlp,
              pap: observable.pap,
              message: observable.message || context,
              parameters: {},
              label: context,
            }),
          }, {
            field: 'attachment',
            filename: observable.attachment.filename,
            contentType: observable.attachment.contentType || 'application/octet-stream',
            data: buffer,
          });
        } else {
          job = await this.call(server, 'POST', `/api/analyzer/${encodeURIComponent(item.analyzerId)}/run`, {
            data: observable.data,
            dataType: observable.dataType,
            tlp: observable.tlp,
            pap: observable.pap,
            message: observable.message || context,
            parameters: {},
            label: context,
          });
        }
        const report = await this.prisma.observableReport.create({
          data: {
            observableId: observable.id,
            analyzer: job.analyzerName || job.analyzerDefinitionId || item.analyzerId,
            analyzerId: item.analyzerId,
            connectorId: server.id,
            cortexJobId: job.id || job._id,
            // Cached jobs come back already finished: keep them pending until the report is fetched.
            status: PENDING.includes(job.status) ? job.status : 'InProgress',
            createdById: user.id,
          },
        });
        created.push(report);
      } catch (e: any) {
        errors.push({ analyzerId: item.analyzerId, error: e.message });
      }
    }
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'analyze',
      objectType: 'observable',
      objectId: observable.id,
      details: { analyzers: requested.map((r) => r.analyzerId), errors: errors.length },
    });
    // Resolve cached/instant jobs right away so the UI shows results without waiting for the poller.
    await Promise.all(created.map((r) => this.refreshReport(r.id).catch(() => undefined)));
    if (!created.length && errors.length) throw new BadRequestException(errors.map((e) => `${e.analyzerId}: ${e.error}`).join('; '));
    return { reports: await this.prisma.observableReport.findMany({ where: { id: { in: created.map((r) => r.id) } } }), errors };
  }

  async listReports(user: AuthUser, observableId: string) {
    await this.loadObservable(user, observableId);
    return this.prisma.observableReport.findMany({ where: { observableId }, orderBy: { createdAt: 'desc' } });
  }

  async getReport(user: AuthUser, observableId: string, reportId: string) {
    await this.loadObservable(user, observableId);
    const report = await this.prisma.observableReport.findFirst({ where: { id: reportId, observableId } });
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }

  /** Creates observables (same case/alert) from the artifacts a Cortex report extracted. */
  async importArtifacts(user: AuthUser, observableId: string, reportId: string, body: any) {
    const observable = await this.loadObservable(user, observableId);
    const report = await this.getReport(user, observableId, reportId);
    const artifacts: any[] = Array.isArray(report.artifacts) ? (report.artifacts as any[]) : [];
    const selected: number[] | null = Array.isArray(body?.indexes) ? body.indexes.map(Number) : null;
    const scopeWhere = observable.caseId ? { caseId: observable.caseId } : { alertId: observable.alertId };
    const created: any[] = [];
    let skipped = 0;
    for (const [index, artifact] of artifacts.entries()) {
      if (selected && !selected.includes(index)) continue;
      if (!artifact?.dataType || artifact.data === undefined) { skipped++; continue; }
      const data = String(artifact.data);
      const dataHash = createHash('sha256').update(`${artifact.dataType}:${data.toLowerCase()}`).digest('hex');
      const exists = await this.prisma.observable.findFirst({ where: { ...scopeWhere, dataHash } });
      if (exists) { skipped++; continue; }
      created.push(
        await this.prisma.observable.create({
          data: {
            organisationId: user.organisationId,
            caseId: observable.caseId,
            alertId: observable.caseId ? null : observable.alertId,
            dataType: artifact.dataType,
            data,
            dataHash,
            message: artifact.message || `Extracted by ${report.analyzer} from ${observable.data}`,
            tlp: Number(artifact.tlp ?? observable.tlp),
            pap: observable.pap,
            tags: Array.isArray(artifact.tags) ? artifact.tags.map(String) : [],
            createdById: user.id,
          },
        }),
      );
    }
    return { created: created.length, skipped, observables: created };
  }

  // ---------------------------------------------------------------- responders

  async listResponders(user: AuthUser, target: ResponderTarget) {
    const dataType = RESPONDER_DATATYPE[target];
    if (!dataType) throw new BadRequestException('Unsupported responder target');
    const servers = await this.connectors.list(user, 'cortex');
    const responders: any[] = [];
    const errors: any[] = [];
    for (const server of servers) {
      try {
        const list = await this.call(server, 'GET', `/api/responder/type/${encodeURIComponent(dataType)}`);
        for (const r of Array.isArray(list) ? list : []) {
          responders.push({ connectorId: server.id, connectorName: server.name, id: r.id, name: r.name, version: r.version, description: r.description });
        }
      } catch (e: any) {
        errors.push({ connectorId: server.id, connectorName: server.name, error: e.message });
      }
    }
    return { responders, errors, servers: servers.length };
  }

  async runResponder(user: AuthUser, target: ResponderTarget, objectId: string, body: any) {
    if (!body?.connectorId || !body?.responderId) throw new BadRequestException('connectorId and responderId are required');
    const server = await this.connectors.get(user, body.connectorId, 'cortex');
    const { data, tlp, pap } = await this.buildResponderPayload(user, target, objectId);
    const job = await this.call(server, 'POST', `/api/responder/${encodeURIComponent(body.responderId)}/run`, {
      data,
      dataType: RESPONDER_DATATYPE[target],
      tlp,
      pap,
      message: body.message || '',
      parameters: body.parameters || {},
      label: `Nuestracolmena ${target} ${objectId}`,
    });
    const record = await this.prisma.job.create({
      data: {
        organisationId: user.organisationId,
        type: 'cortex-responder',
        status: PENDING.includes(job.status) ? job.status : 'InProgress',
        payload: {
          connectorId: server.id,
          responderId: body.responderId,
          responderName: body.responderName || job.responderName || body.responderId,
          cortexJobId: job.id || job._id,
          objectType: target,
          objectId,
        },
        createdById: user.id,
        startedAt: new Date(),
      },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'run-responder', objectType: target, objectId, details: { responder: body.responderId } });
    await this.refreshResponderJob(record.id).catch(() => undefined);
    return this.prisma.job.findUnique({ where: { id: record.id } });
  }

  async listActions(user: AuthUser, target: ResponderTarget, objectId: string) {
    return this.prisma.job.findMany({
      where: {
        organisationId: user.organisationId,
        type: 'cortex-responder',
        AND: [{ payload: { path: ['objectType'], equals: target } }, { payload: { path: ['objectId'], equals: objectId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // ---------------------------------------------------------------- polling

  /** Called by the scheduler: refreshes every analyzer report / responder job still running. */
  async pollPending() {
    const reports = await this.prisma.observableReport.findMany({
      where: { status: { in: PENDING }, cortexJobId: { not: null } },
      select: { id: true },
      take: 50,
    });
    for (const r of reports) await this.refreshReport(r.id).catch((e) => this.logger.warn(`report ${r.id}: ${e.message}`));
    const jobs = await this.prisma.job.findMany({
      where: { type: 'cortex-responder', status: { in: PENDING } },
      select: { id: true },
      take: 50,
    });
    for (const j of jobs) await this.refreshResponderJob(j.id).catch((e) => this.logger.warn(`responder job ${j.id}: ${e.message}`));
    return { reports: reports.length, responders: jobs.length };
  }

  async refreshReport(reportId: string) {
    const report = await this.prisma.observableReport.findUnique({ where: { id: reportId } });
    if (!report?.cortexJobId || !report.connectorId || FINAL.includes(report.status)) return report;
    const server = await this.connectors.getById(report.connectorId);
    if (!server) {
      const failed = await this.prisma.observableReport.update({ where: { id: reportId }, data: { status: 'Failure', errorMessage: 'Cortex server was removed' } });
      await this.auditAnalyzerFinished(report, failed);
      return failed;
    }
    const job = await this.fetchJob(server, report.cortexJobId);
    if (!job) {
      const failed = await this.prisma.observableReport.update({ where: { id: reportId }, data: { status: 'Failure', errorMessage: 'Job not found in Cortex' } });
      await this.auditAnalyzerFinished(report, failed);
      return failed;
    }
    if (!FINAL.includes(job.status)) {
      return job.status !== report.status ? this.prisma.observableReport.update({ where: { id: reportId }, data: { status: job.status } }) : report;
    }
    const full = await this.call(server, 'GET', `/api/job/${encodeURIComponent(report.cortexJobId)}/report`);
    const r = full?.report || {};
    const success = job.status === 'Success' && r.success !== false;
    const updated = await this.prisma.observableReport.update({
      where: { id: reportId },
      data: {
        status: success ? 'Success' : 'Failure',
        errorMessage: success ? null : r.errorMessage || job.errorMessage || 'Analyzer failed',
        taxonomies: (r.summary?.taxonomies || []) as any,
        artifacts: (r.artifacts || []) as any,
        report: (r.full ?? r) as any,
      },
    });
    await this.auditAnalyzerFinished(report, updated);
    return updated;
  }

  private async auditAnalyzerFinished(report: any, updated: any) {
    const observable = await this.prisma.observable.findUnique({
      where: { id: report.observableId },
      select: { organisationId: true, caseId: true, alertId: true, dataType: true, data: true },
    });
    await this.audit.log({
      organisationId: observable?.organisationId ?? null,
      actorId: report.createdById,
      action: 'finish',
      objectType: 'job',
      objectId: report.id,
      rootId: observable?.caseId || observable?.alertId || null,
      rootType: observable?.caseId ? 'Case' : observable?.alertId ? 'Alert' : null,
      details: {
        kind: 'analyzer',
        reportId: report.id,
        observableId: report.observableId,
        analyzer: report.analyzer,
        status: updated.status,
        caseId: observable?.caseId,
        alertId: observable?.alertId,
        dataType: observable?.dataType,
        data: observable?.data,
      },
      object: updated,
    });
  }

  async refreshResponderJob(jobId: string) {
    const record = await this.prisma.job.findUnique({ where: { id: jobId } });
    const payload: any = record?.payload || {};
    if (!record || !payload.cortexJobId || FINAL.includes(record.status)) return record;
    const server = await this.connectors.getById(payload.connectorId);
    if (!server) {
      const failed = await this.prisma.job.update({ where: { id: jobId }, data: { status: 'Failure', finishedAt: new Date(), result: { error: 'Cortex server was removed' } } });
      await this.auditResponderFinished(record, payload, failed);
      return failed;
    }
    const job = await this.fetchJob(server, payload.cortexJobId);
    if (!job) {
      const failed = await this.prisma.job.update({ where: { id: jobId }, data: { status: 'Failure', finishedAt: new Date(), result: { error: 'Job not found in Cortex' } } });
      await this.auditResponderFinished(record, payload, failed);
      return failed;
    }
    if (!FINAL.includes(job.status)) return record.status !== job.status ? this.prisma.job.update({ where: { id: jobId }, data: { status: job.status } }) : record;
    const full = await this.call(server, 'GET', `/api/job/${encodeURIComponent(payload.cortexJobId)}/report`);
    const r = full?.report || {};
    const success = job.status === 'Success' && r.success !== false;
    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: success ? 'Success' : 'Failure',
        finishedAt: new Date(),
        result: { success, message: r.full?.message, operations: r.operations || [], errorMessage: r.errorMessage || job.errorMessage, full: r.full ?? null },
      },
    });
    await this.auditResponderFinished(record, payload, updated);
    return updated;
  }

  private async auditResponderFinished(record: any, payload: any, updated: any) {
    await this.audit.log({
      organisationId: record.organisationId,
      actorId: record.createdById,
      action: 'finish',
      objectType: 'job',
      objectId: record.id,
      rootId: payload.objectType === 'case' || payload.objectType === 'alert' ? payload.objectId : null,
      rootType: payload.objectType === 'case' ? 'Case' : payload.objectType === 'alert' ? 'Alert' : null,
      details: {
        kind: 'responder',
        jobId: record.id,
        cortexJobId: payload.cortexJobId,
        responderId: payload.responderId,
        responderName: payload.responderName,
        objectType: payload.objectType,
        objectId: payload.objectId,
        status: updated.status,
      },
      object: updated,
    });
  }

  // ---------------------------------------------------------------- helpers

  private async fetchJob(server: Connector, cortexJobId: string) {
    try {
      return await this.call(server, 'GET', `/api/job/${encodeURIComponent(cortexJobId)}`);
    } catch (e) {
      if (e instanceof ExternalServiceError && e.status === 404) return null;
      throw e;
    }
  }

  private async callMultipart(server: Connector, path: string, fields: Record<string, string>, file: { field: string; filename: string; contentType?: string; data: Buffer }) {
    const res = await httpMultipart(joinUrl(server.config.url, path), {
      method: 'POST',
      fields,
      files: [file],
      headers: this.connectors.authHeaders(server),
      insecure: server.config.verifyTls === false,
      timeoutMs: 60000,
    });
    if (!res.ok) {
      const detail = typeof res.data === 'object' ? res.data?.message || res.data?.type || JSON.stringify(res.data) : res.text;
      throw new ExternalServiceError(`Cortex ${server.name}: HTTP ${res.status} ${String(detail || '').slice(0, 300)}`, res.status, res.data);
    }
    return res.data;
  }

  private async call(server: Connector, method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await httpJson(joinUrl(server.config.url, path), {
      method,
      body,
      headers: this.connectors.authHeaders(server),
      insecure: server.config.verifyTls === false,
      timeoutMs: 30000,
    });
    if (!res.ok) {
      const detail = typeof res.data === 'object' ? res.data?.message || res.data?.type || JSON.stringify(res.data) : res.text;
      throw new ExternalServiceError(`Cortex ${server.name}: HTTP ${res.status} ${String(detail || '').slice(0, 300)}`, res.status, res.data);
    }
    return res.data;
  }

  private async loadObservable(user: AuthUser, id: string) {
    const observable = await this.prisma.observable.findFirst({
      where: { id, organisationId: user.organisationId },
      include: { attachment: true, case: { select: { id: true, number: true } }, alert: { select: { id: true, title: true } } },
    });
    if (!observable) throw new NotFoundException('Observable not found');
    return observable;
  }

  private async buildResponderPayload(user: AuthUser, target: ResponderTarget, id: string) {
    const ms = (d?: Date | null) => (d ? new Date(d).getTime() : null);
    if (target === 'case') {
      const c = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId }, include: { assignee: true, observables: true } });
      if (!c) throw new NotFoundException('Case not found');
      return {
        tlp: c.tlp,
        pap: c.pap,
        data: {
          _id: c.id, id: c.id, _type: 'case', caseId: c.number, title: c.title, description: c.description, summary: c.summary,
          severity: c.severity, tlp: c.tlp, pap: c.pap, tags: c.tags, flag: c.flag,
          status: c.stage === 'Closed' ? 'Resolved' : 'Open', stage: c.stage, owner: c.assignee?.login || null,
          startDate: ms(c.startDate), endDate: ms(c.endDate), createdAt: ms(c.createdAt), customFields: c.customFields,
          artifacts: c.observables.map((o) => ({ dataType: o.dataType, data: o.data, message: o.message, tlp: o.tlp, ioc: o.ioc, tags: o.tags })),
        },
      };
    }
    if (target === 'task') {
      const t = await this.prisma.caseTask.findFirst({ where: { id, organisationId: user.organisationId }, include: { assignee: true, case: true } });
      if (!t) throw new NotFoundException('Task not found');
      return {
        tlp: t.case.tlp,
        pap: t.case.pap,
        data: {
          _id: t.id, id: t.id, _type: 'case_task', title: t.title, description: t.description, status: t.status, group: t.group,
          owner: t.assignee?.login || null, flag: t.flag, startDate: ms(t.startDate), endDate: ms(t.endDate),
          case: { _id: t.case.id, caseId: t.case.number, title: t.case.title },
        },
      };
    }
    if (target === 'observable') {
      const o = await this.loadObservable(user, id);
      return {
        tlp: o.tlp,
        pap: o.pap,
        data: {
          _id: o.id, id: o.id, _type: 'case_artifact', dataType: o.dataType, data: o.data, message: o.message, tlp: o.tlp, pap: o.pap,
          ioc: o.ioc, sighted: o.sighted, tags: o.tags, startDate: ms(o.startDate),
          case: o.case ? { _id: o.case.id, caseId: o.case.number } : undefined,
        },
      };
    }
    const a = await this.prisma.alert.findFirst({ where: { id, organisationId: user.organisationId }, include: { observables: true } });
    if (!a) throw new NotFoundException('Alert not found');
    return {
      tlp: a.tlp,
      pap: a.pap,
      data: {
        _id: a.id, id: a.id, _type: 'alert', title: a.title, description: a.description, severity: a.severity, tlp: a.tlp, pap: a.pap,
        tags: a.tags, type: a.type, source: a.source, sourceRef: a.sourceRef, date: ms(a.date), status: a.stage,
        artifacts: a.observables.map((o) => ({ dataType: o.dataType, data: o.data, message: o.message, tlp: o.tlp, tags: o.tags })),
      },
    };
  }
}
