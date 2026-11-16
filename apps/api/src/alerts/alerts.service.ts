import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/decorators/auth.decorators';
import { CasesService, normaliseTags, sortClause } from '../cases/cases.service';
import { SlaService } from '../sla/sla.service';
import { CorrelationService } from '../correlation/correlation.service';
import { attachPatterns, enrichProcedures } from '../mitre/pattern-helpers';
import { AttachmentsService } from '../attachments/attachments.service';

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cases: CasesService,
    private readonly sla: SlaService,
    private readonly correlation: CorrelationService,
    private readonly attachments: AttachmentsService,
  ) {}

  async list(user: AuthUser, query: any) {
    const where: any = { organisationId: user.organisationId };
    if (query.stage) where.stage = query.stage;
    if (query.status) where.status = { value: query.status };
    if (query.severity) where.severity = Number(query.severity);
    if (query.read !== undefined) where.read = query.read === 'true' || query.read === true;
    if (query.follow !== undefined) where.follow = query.follow === 'true' || query.follow === true;
    if (query.type) where.type = query.type;
    if (query.source) where.source = query.source;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { sourceRef: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const page = Math.max(0, Number(query.page ?? 0));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 30)));
    const orderBy = sortClause(query.sort, '-date', ['date', 'createdAt', 'updatedAt', 'title', 'severity', 'tlp', 'pap', 'stage', 'type', 'source', 'read', 'flag']);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.alert.findMany({
        where,
        include: {
          status: true,
          assignee: { select: { id: true, login: true, name: true } },
          case: { select: { id: true, number: true, title: true } },
          _count: { select: { observables: true, procedures: true } },
        },
        orderBy,
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.alert.count({ where }),
    ]);
    const rules = await this.sla.rulesFor(user.organisationId);
    const similarCaseCounts = await this.correlation.similarCaseCounts(user, items.map((item: any) => item.id));
    const observableIds = items.flatMap((item: any) => (item.observables || []).map((observable: any) => observable.id));
    const seen = observableIds.length ? await this.correlation.seenCounts(user, observableIds) : {};
    const decorated = items.map((item: any) => ({
      ...item,
      similarCaseCount: similarCaseCounts[item.id] ?? 0,
      observables: item.observables
        ? item.observables.map((observable: any) => ({ ...observable, seenCount: seen[observable.id] ?? 0 }))
        : undefined,
    }));
    return { items: this.sla.attach(decorated, 'alert', rules), total, page, pageSize };
  }

  async get(user: AuthUser, id: string) {
    const alert = await this.prisma.alert.findFirst({
      where: { id, organisationId: user.organisationId },
      include: {
        status: true,
        assignee: { select: { id: true, login: true, name: true } },
        createdBy: { select: { id: true, login: true, name: true } },
        case: { select: { id: true, number: true, title: true } },
        observables: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachment: true,
            reports: { select: { id: true, analyzer: true, status: true, taxonomies: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
          },
        },
        procedures: true,
      },
    });
    if (!alert) throw new NotFoundException('Alert not found');
    const seen = await this.correlation.seenCounts(user, (alert.observables || []).map((observable: any) => observable.id));
    return {
      ...alert,
      observables: await Promise.all((alert.observables || []).map(async (observable: any) => ({
        ...observable,
        seenCount: seen[observable.id] ?? 0,
        attachment: observable.attachment ? await this.attachments.withHashes(observable.attachment) : null,
      }))),
      procedures: await attachPatterns(this.prisma, alert.procedures || []),
      sla: await this.sla.evaluate(alert, 'alert'),
    };
  }

  async create(user: AuthUser, data: any) {
    if (!data.title || !data.type || !data.source || !data.sourceRef) {
      throw new BadRequestException('title, type, source and sourceRef are required');
    }
    const status = await this.resolveStatus(user.organisationId, data.status || 'New');
    const initialStage = status?.stage || 'New';
    const initialRead = !!data.read;
    const procedures = Array.isArray(data.procedures) ? await enrichProcedures(this.prisma, data.procedures) : data.procedures;
    const alert = await this.prisma.alert.create({
      data: {
        organisationId: user.organisationId,
        type: data.type,
        source: data.source,
        sourceRef: data.sourceRef,
        externalLink: data.externalLink || null,
        title: data.title,
        description: data.description || '',
        summary: data.summary || null,
        severity: Number(data.severity ?? 2),
        tlp: Number(data.tlp ?? 2),
        pap: Number(data.pap ?? 2),
        statusId: status?.id,
        stage: initialStage,
        acknowledgedAt: initialRead || (initialStage !== 'New' && initialStage !== 'Closed') ? new Date() : null,
        assigneeId: data.assignee ? await this.resolveUserId(data.assignee, user.organisationId) : null,
        date: data.date ? new Date(data.date) : new Date(),
        flag: !!data.flag,
        follow: data.follow !== false,
        read: !!data.read,
        tags: normaliseTags(Array.isArray(data.tags) ? data.tags : []),
        customFields: data.customFields || {},
        createdById: user.id,
        observables: Array.isArray(data.observables)
          ? {
              create: data.observables.map((o: any) => ({
                organisationId: user.organisationId,
                dataType: o.dataType,
                data: String(o.data),
                dataHash: createHash('sha256').update(`${o.dataType}:${String(o.data).toLowerCase()}`).digest('hex'),
                message: o.message || null,
                tlp: Number(o.tlp ?? data.tlp ?? 2),
                pap: Number(o.pap ?? data.pap ?? 2),
                ioc: !!o.ioc,
                sighted: !!o.sighted,
                ignoreSimilarity: !!o.ignoreSimilarity,
                tags: o.tags || [],
                createdById: user.id,
              })),
            }
          : undefined,
        procedures: Array.isArray(procedures)
          ? {
              create: procedures.map((p: any) => ({
                organisationId: user.organisationId,
                patternId: p.patternId,
                patternName: p.patternName || p.patternId,
                tactic: p.tactic || null,
                occurDate: p.occurDate ? new Date(p.occurDate) : new Date(),
                description: p.description || '',
                createdById: user.id,
              })),
            }
          : undefined,
      },
      include: {
        observables: true,
        procedures: true,
        status: true,
        assignee: { select: { id: true, login: true, name: true } },
        createdBy: { select: { id: true, login: true, name: true } },
      },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'create', objectType: 'alert', objectId: alert.id, rootId: alert.id, rootType: 'Alert', details: { title: alert.title, severity: alert.severity, tags: alert.tags } });
    for (const observable of alert.observables || []) {
      await this.audit.log({
        organisationId: user.organisationId,
        actorId: user.id,
        action: 'create',
        objectType: 'observable',
        objectId: observable.id,
        rootId: alert.id,
        rootType: 'Alert',
        details: { alertId: alert.id, dataType: observable.dataType, data: observable.data, tags: observable.tags, tlp: observable.tlp, pap: observable.pap, inline: true },
        object: observable,
      });
    }
    return alert;
  }

  async update(user: AuthUser, id: string, data: any) {
    const alert = await this.prisma.alert.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!alert) throw new NotFoundException('Alert not found');
    const status = data.status ? await this.resolveStatus(user.organisationId, data.status) : null;
    const updated = await this.prisma.alert.update({
      where: { id },
      data: {
        title: data.title ?? undefined,
        description: data.description ?? undefined,
        summary: data.summary ?? undefined,
        severity: data.severity !== undefined ? Number(data.severity) : undefined,
        tlp: data.tlp !== undefined ? Number(data.tlp) : undefined,
        pap: data.pap !== undefined ? Number(data.pap) : undefined,
        statusId: status?.id ?? undefined,
        stage: status?.stage ?? undefined,
        assigneeId: data.assignee !== undefined ? (data.assignee ? await this.resolveUserId(data.assignee, user.organisationId) : null) : undefined,
        date: data.date ? new Date(data.date) : undefined,
        externalLink: data.externalLink ?? undefined,
        flag: data.flag ?? undefined,
        follow: data.follow ?? undefined,
        read: data.read ?? undefined,
        tags: this.mergeTags(alert.tags, data),
        customFields: data.customFields ?? undefined,
      },
      include: { status: true, assignee: { select: { id: true, login: true, name: true } }, createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'alert',
      objectId: id,
      rootId: id,
      rootType: 'Alert',
      details: {
        assigneeId: updated.assigneeId,
        previousAssigneeId: alert.assigneeId,
        stage: updated.stage,
        severity: updated.severity,
        tags: updated.tags,
        title: updated.title,
      },
    });
    if (!alert.acknowledgedAt && (updated.read || (updated.stage !== 'New' && updated.stage !== 'Closed'))) {
      updated.acknowledgedAt = new Date();
      await this.prisma.alert.update({ where: { id }, data: { acknowledgedAt: updated.acknowledgedAt } });
    }
    return { ...updated, sla: await this.sla.evaluate(updated, 'alert') };
  }

  async remove(user: AuthUser, id: string) {
    const alert = await this.prisma.alert.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!alert) throw new NotFoundException('Alert not found');
    const observables = await this.prisma.observable.findMany({ where: { alertId: id }, select: { id: true } });
    // Comments are polymorphic and have no FK, so they must be removed explicitly.
    const commentOwners = [
      { objectType: 'alert', objectId: id },
      ...observables.map((row) => ({ objectType: 'observable', objectId: row.id })),
    ];
    const comments = await this.prisma.comment.findMany({ where: { OR: commentOwners }, select: { id: true } });
    if (comments.length) {
      await this.prisma.comment.deleteMany({ where: { id: { in: comments.map((row) => row.id) } } });
    }
    await this.prisma.alert.delete({ where: { id } });
    await this.attachments.removeForOwners([
      ...commentOwners,
      ...comments.map((row) => ({ objectType: 'comment', objectId: row.id })),
    ], user.id);
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'delete',
      objectType: 'alert',
      objectId: id,
      rootId: id,
      rootType: 'Alert',
      details: { title: alert.title, severity: alert.severity, tags: alert.tags, stage: alert.stage },
      object: alert,
    });
    return { ok: true };
  }

  async mark(user: AuthUser, id: string, data: { read?: boolean; follow?: boolean }) {
    const alert = await this.prisma.alert.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!alert) throw new NotFoundException('Alert not found');
    const updated = await this.prisma.alert.update({
      where: { id },
      data: { read: data.read ?? undefined, follow: data.follow ?? undefined },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'alert',
      objectId: id,
      rootId: id,
      rootType: 'Alert',
      details: { read: updated.read, follow: updated.follow, assigneeId: updated.assigneeId, severity: updated.severity, tags: updated.tags, title: updated.title },
    });
    if (!alert.acknowledgedAt && updated.read) {
      updated.acknowledgedAt = new Date();
      await this.prisma.alert.update({ where: { id }, data: { acknowledgedAt: updated.acknowledgedAt } });
    }
    return { ...updated, sla: await this.sla.evaluate(updated, 'alert') };
  }

  async bulk(user: AuthUser, ids: string[], data: any) {
    const result = await this.prisma.alert.updateMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      data: {
        read: data.read ?? undefined,
        follow: data.follow ?? undefined,
        severity: data.severity !== undefined ? Number(data.severity) : undefined,
        tlp: data.tlp !== undefined ? Number(data.tlp) : undefined,
        pap: data.pap !== undefined ? Number(data.pap) : undefined,
        flag: data.flag ?? undefined,
      },
    });
    if (data.read === true) {
      await this.prisma.alert.updateMany({
        where: { id: { in: ids }, organisationId: user.organisationId, acknowledgedAt: null },
        data: { acknowledgedAt: new Date() },
      });
    }
    if (Array.isArray(data.addTags) || Array.isArray(data.removeTags)) {
      const alerts = await this.prisma.alert.findMany({ where: { id: { in: ids }, organisationId: user.organisationId } });
      for (const alert of alerts) {
        await this.prisma.alert.update({ where: { id: alert.id }, data: { tags: this.mergeTags(alert.tags, data) } });
      }
    }
    const alerts = await this.prisma.alert.findMany({ where: { id: { in: ids }, organisationId: user.organisationId } });
    for (const alert of alerts) {
      await this.audit.log({
        organisationId: user.organisationId,
        actorId: user.id,
        action: 'update',
        objectType: 'alert',
        objectId: alert.id,
        rootId: alert.id,
        rootType: 'Alert',
        details: { read: alert.read, follow: alert.follow, assigneeId: alert.assigneeId, stage: alert.stage, severity: alert.severity, tags: alert.tags, title: alert.title, bulk: true },
      });
    }
    return result;
  }

  private mergeTags(current: string[], data: any): string[] | undefined {
    if (Array.isArray(data.tags)) return normaliseTags(data.tags);
    if (Array.isArray(data.addTags) || Array.isArray(data.removeTags)) {
      return normaliseTags([
        ...(current || []).filter((tag) => !(data.removeTags || []).includes(tag)),
        ...(data.addTags || []),
      ]);
    }
    return undefined;
  }

  async importToCase(user: AuthUser, id: string, data: any) {
    const alert = await this.get(user, id);
    if (alert.caseId) throw new BadRequestException('Alert is already linked to a case');
    const created = await this.cases.createCase(user, {
      title: data.title || alert.title,
      description: data.description || alert.description,
      summary: data.summary || alert.summary,
      severity: data.severity ?? alert.severity,
      tlp: data.tlp ?? alert.tlp,
      pap: data.pap ?? alert.pap,
      tags: data.tags || alert.tags,
      status: data.status || 'New',
      caseTemplate: data.caseTemplate,
      tasks: data.tasks || [],
    });
    await this.prisma.observable.updateMany({ where: { alertId: alert.id }, data: { caseId: created.id } });
    await this.prisma.procedure.updateMany({ where: { alertId: alert.id }, data: { caseId: created.id } });
    const imported = await this.resolveStatus(user.organisationId, 'Imported');
    await this.prisma.alert.update({
      where: { id },
      data: { caseId: created.id, stage: 'Imported', statusId: imported?.id, acknowledgedAt: alert.acknowledgedAt || new Date() },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'import-to-case', objectType: 'alert', objectId: id, rootId: id, rootType: 'Alert', details: { caseId: created.id, title: alert.title, severity: alert.severity, tags: alert.tags } });
    const copiedObservables = await this.prisma.observable.findMany({ where: { alertId: alert.id, caseId: created.id } });
    for (const observable of copiedObservables) {
      await this.audit.log({
        organisationId: user.organisationId,
        actorId: user.id,
        action: 'create',
        objectType: 'observable',
        objectId: observable.id,
        rootId: created.id,
        rootType: 'Case',
        details: { caseId: created.id, alertId: alert.id, dataType: observable.dataType, data: observable.data, tags: observable.tags, tlp: observable.tlp, pap: observable.pap, imported: true },
        object: observable,
      });
    }
    return this.cases.getCase(user, created.id);
  }

  async mergeIntoCase(user: AuthUser, id: string, caseId: string) {
    const alert = await this.get(user, id);
    if (alert.caseId) throw new BadRequestException('Alert is already linked to a case');
    const target = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId } });
    if (!target) throw new NotFoundException('Case not found');
    if (alert.tags?.length) {
      await this.prisma.case.update({ where: { id: caseId }, data: { tags: normaliseTags([...target.tags, ...alert.tags]) } });
    }
    await this.prisma.observable.updateMany({ where: { alertId: alert.id }, data: { caseId } });
    await this.prisma.procedure.updateMany({ where: { alertId: alert.id }, data: { caseId } });
    const status = await this.resolveStatus(user.organisationId, 'Imported');
    await this.prisma.alert.update({
      where: { id },
      data: { caseId, stage: 'Imported', statusId: status?.id, acknowledgedAt: alert.acknowledgedAt || new Date() },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'merge-alert', objectType: 'alert', objectId: id, rootId: id, rootType: 'Alert', details: { caseId, title: alert.title, severity: alert.severity, tags: alert.tags } });
    return this.cases.getCase(user, caseId);
  }

  async createObservable(user: AuthUser, id: string, data: any) {
    await this.get(user, id);
    return this.cases.createObservable(user, { ...data, alertId: id });
  }

  async createFileObservables(user: AuthUser, id: string, files: any[], body: any = {}) {
    await this.get(user, id);
    return this.cases.createFileObservables(user, { alertId: id }, files, body);
  }

  async createProcedure(user: AuthUser, id: string, data: any) {
    await this.get(user, id);
    return this.cases.createProcedure(user, { ...data, alertId: id });
  }

  private async resolveStatus(organisationId: string, value: string) {
    return this.prisma.alertStatus.findFirst({ where: { organisationId, value } });
  }

  private async resolveUserId(loginOrId: string, organisationId: string) {
    const u = await this.prisma.user.findFirst({
      where: { OR: [{ id: loginOrId }, { login: loginOrId }], memberships: { some: { organisationId } } },
    });
    return u?.id || null;
  }
}
