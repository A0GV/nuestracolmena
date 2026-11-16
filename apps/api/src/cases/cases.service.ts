import { BadRequestException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/decorators/auth.decorators';
import { SlaService } from '../sla/sla.service';
import { CorrelationService } from '../correlation/correlation.service';
import { attachPatterns, enrichProcedureInput } from '../mitre/pattern-helpers';
import { AttachmentsService } from '../attachments/attachments.service';

@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sla: SlaService,
    private readonly correlation: CorrelationService,
    private readonly attachments: AttachmentsService,
  ) {}

  async listCases(user: AuthUser, query: any) {
    const page = Math.max(0, Number(query.page ?? 0));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 30)));
    const shares = await this.prisma.share.findMany({ where: { sharedWithOrgId: user.organisationId, objectType: 'case' }, select: { objectId: true } });
    const sharedIds = shares.map((s) => s.objectId);
    const where: any = sharedIds.length
      ? { OR: [{ organisationId: user.organisationId }, { id: { in: sharedIds } }] }
      : { organisationId: user.organisationId };
    if (query.stage) where.stage = query.stage;
    if (query.status) where.status = { value: query.status };
    if (query.severity) where.severity = Number(query.severity);
    if (query.assignee) where.assignee = { login: query.assignee };
    if (query.flag) where.flag = query.flag === 'true' || query.flag === true;
    if (query.tags) {
      const tags = String(query.tags).split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length) where.tags = { hasSome: tags };
    }
    if (query.search) {
      const search = String(query.search).trim().replace(/^#/, '');
      where.AND = [
        {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { tags: { has: search } },
            ...(/^\d+$/.test(search) ? [{ number: Number(search) }] : []),
          ],
        },
      ];
    }
    const orderBy = sortClause(query.sort, '-createdAt', CASE_SORT_FIELDS);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.case.findMany({
        where,
        include: {
          status: true,
          assignee: { select: { id: true, login: true, name: true } },
          createdBy: { select: { id: true, login: true, name: true } },
          _count: { select: { tasks: true, observables: true, procedures: true, alerts: true } },
        },
        orderBy,
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.case.count({ where }),
    ]);
    const rules = await this.sla.rulesFor(user.organisationId);
    return { items: this.sla.attach(items, 'case', rules), total, page, pageSize };
  }

  async getCase(user: AuthUser, idOrNumber: string) {
    const shares = await this.prisma.share.findMany({ where: { sharedWithOrgId: user.organisationId, objectType: 'case' }, select: { objectId: true } });
    const sharedIds = shares.map((s) => s.objectId);
    const ownership = sharedIds.length
      ? { OR: [{ organisationId: user.organisationId }, { id: { in: sharedIds } }] }
      : { organisationId: user.organisationId };
    const where: any = { AND: [ownership] };
    if (/^\d+$/.test(idOrNumber)) where.AND.push({ number: Number(idOrNumber) });
    else where.AND.push({ id: idOrNumber });
    const item = await this.prisma.case.findFirst({
      where,
      include: {
        status: true,
        assignee: { select: { id: true, login: true, name: true } },
        createdBy: { select: { id: true, login: true, name: true } },
        tasks: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
        observables: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachment: true,
            reports: { select: { id: true, analyzer: true, status: true, taxonomies: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
          },
        },
        procedures: { orderBy: { occurDate: 'desc' } },
        alerts: { orderBy: { date: 'desc' } },
        mergedInto: { select: { id: true, number: true, title: true } },
      },
    });
    if (!item) throw new NotFoundException('Case not found');
    const comments = await this.prisma.comment.findMany({
      where: { objectType: 'case', objectId: item.id },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const rules = await this.sla.rulesFor(user.organisationId);
    const seen = await this.correlation.seenCounts(user, (item.observables || []).map((observable: any) => observable.id));
    return {
      ...item,
      observables: await Promise.all((item.observables || []).map(async (observable: any) => ({
        ...observable,
        seenCount: seen[observable.id] ?? 0,
        attachment: observable.attachment ? await this.attachments.withHashes(observable.attachment) : null,
      }))),
      tasks: this.sla.attach(item.tasks || [], 'task', rules),
      procedures: await attachPatterns(this.prisma, item.procedures || []),
      comments,
      sla: this.sla.evaluateWithRules(item, 'case', rules),
    };
  }

  async createCase(user: AuthUser, data: any) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.createCaseOnce(user, data);
      } catch (e: any) {
        // Two cases created at the same time can race for the same number: retry.
        if (e?.code === 'P2002' && String(e?.meta?.target || '').includes('number') && attempt < 4) continue;
        throw e;
      }
    }
  }

  private async createCaseOnce(user: AuthUser, data: any) {
    if (!data.title?.trim()) throw new BadRequestException('title is required');
    const organisationId = user.organisationId;
    const status = await this.resolveCaseStatus(organisationId, data.status || 'New');
    const last = await this.prisma.case.findFirst({
      where: { organisationId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const template = data.caseTemplate
      ? await this.prisma.caseTemplate.findFirst({
          where: { organisationId, name: data.caseTemplate },
          include: { tasks: { orderBy: { order: 'asc' } } },
        })
      : null;
    if (data.caseTemplate && !template) throw new BadRequestException(`Case template not found: ${data.caseTemplate}`);

    const caseTasks = tasks.length
      ? tasks
      : template?.tasks?.map((t: any) => ({
          title: t.title,
          group: t.group,
          description: t.description,
          status: 'Waiting',
          mandatory: t.mandatory,
          order: t.order,
          dueDate: t.dueDays ? new Date(Date.now() + t.dueDays * 86400000) : null,
        })) || [];
    const observables = Array.isArray(data.observables) ? data.observables : [];
    const assignedUserId = data.assignee ? await this.resolveUserId(data.assignee, organisationId) : user.id;
    const initialStage = status?.stage || 'New';
    const initialAcknowledgedAt = assignedUserId && initialStage !== 'New' && initialStage !== 'Closed' ? new Date() : null;
    const caseTaskRows = await Promise.all(
      caseTasks.map(async (t: any, index: number) => ({
        organisationId,
        title: t.title,
        group: t.group || null,
        description: t.description || '',
        status: t.status || 'Waiting',
        flag: !!t.flag,
        mandatory: !!t.mandatory,
        order: index,
        startDate: t.startDate ? new Date(t.startDate) : null,
        endDate: t.endDate ? new Date(t.endDate) : null,
        dueDate: t.dueDate ? new Date(t.dueDate) : null,
        assigneeId: t.assignee ? await this.resolveUserId(t.assignee, organisationId) : null,
      })),
    );

    const created = await this.prisma.case.create({
      data: {
        organisationId,
        number,
        title: template?.titlePrefix && !data.title.startsWith(template.titlePrefix) ? `${template.titlePrefix} ${data.title}` : data.title,
        description: data.description || template?.description || '',
        summary: data.summary || null,
        severity: Number(data.severity ?? template?.severity ?? 2),
        tlp: Number(data.tlp ?? template?.tlp ?? 2),
        pap: Number(data.pap ?? template?.pap ?? 2),
        tags: normaliseTags([...(Array.isArray(data.tags) ? data.tags : []), ...(template?.tags || [])]),
        statusId: status?.id,
        stage: initialStage,
        assigneeId: assignedUserId,
        acknowledgedAt: initialAcknowledgedAt,
        startDate: data.startDate ? new Date(data.startDate) : new Date(),
        endDate: data.endDate ? new Date(data.endDate) : null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        flag: !!data.flag,
        accessKind: data.accessKind || 'organisation',
        accessOrgIds: data.accessOrgIds || [],
        customFields: { ...((template?.customFields as any) || {}), ...(data.customFields || {}) },
        createdById: user.id,
        tasks: {
          create: caseTaskRows,
        },
        observables: observables.length
          ? {
              create: observables.map((o: any) => ({
                organisationId,
                dataType: o.dataType,
                data: String(o.data),
                dataHash: createHash('sha256').update(`${o.dataType}:${String(o.data).toLowerCase()}`).digest('hex'),
                message: o.message || null,
                tlp: Number(o.tlp ?? data.tlp ?? 2),
                pap: Number(o.pap ?? data.pap ?? 2),
                ioc: !!o.ioc,
                sighted: !!o.sighted,
                ignoreSimilarity: !!o.ignoreSimilarity,
                tags: normaliseTags(o.tags || []),
                createdById: user.id,
              })),
            }
          : undefined,
      },
      include: {
        tasks: true,
        status: true,
        observables: true,
        createdBy: { select: { id: true, login: true, name: true } },
      },
    });

    await this.audit.log({
      organisationId,
      actorId: user.id,
      action: 'create',
      objectType: 'case',
      objectId: created.id,
      rootId: created.id,
      rootType: 'Case',
      details: { number, title: created.title, severity: created.severity, tags: created.tags },
    });
    for (const task of created.tasks || []) {
      await this.audit.log({
        organisationId,
        actorId: user.id,
        action: 'create',
        objectType: 'task',
        objectId: task.id,
        rootId: created.id,
        rootType: 'Case',
        details: { caseId: created.id, assigneeId: task.assigneeId, status: task.status, title: task.title, inline: true },
        object: task,
      });
    }
    for (const observable of created.observables || []) {
      await this.audit.log({
        organisationId,
        actorId: user.id,
        action: 'create',
        objectType: 'observable',
        objectId: observable.id,
        rootId: created.id,
        rootType: 'Case',
        details: { caseId: created.id, dataType: observable.dataType, data: observable.data, tags: observable.tags, tlp: observable.tlp, pap: observable.pap, inline: true },
        object: observable,
      });
    }
    const withDueDate = await this.sla.applyDefaultDueDate(created);
    const rules = await this.sla.rulesFor(organisationId);
    return {
      ...created,
      dueDate: withDueDate.object.dueDate,
      tasks: this.sla.attach(created.tasks || [], 'task', rules),
      sla: this.sla.evaluateWithRules(withDueDate.object, 'case', rules),
    };
  }

  async updateCase(user: AuthUser, id: string, data: any) {
    const current = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!current) throw new NotFoundException('Case not found');
    const status = data.status ? await this.resolveCaseStatus(user.organisationId, data.status) : null;
    const tags = this.mergeTags(current.tags, data);
    const updated = await this.prisma.case.update({
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
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: optionalDate(data.endDate),
        dueDate: optionalDate(data.dueDate),
        flag: data.flag ?? undefined,
        tags,
        accessKind: data.accessKind ?? undefined,
        accessOrgIds: data.accessOrgIds ?? undefined,
        customFields: data.customFields ?? undefined,
      },
      include: { status: true, tasks: true },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'case',
      objectId: id,
      rootId: id,
      rootType: 'Case',
      details: {
        assigneeId: updated.assigneeId,
        previousAssigneeId: current.assigneeId,
        stage: updated.stage,
        severity: updated.severity,
        tags: updated.tags,
        title: updated.title,
      },
    });
    if (!current.acknowledgedAt && updated.assigneeId && updated.stage !== 'New' && updated.stage !== 'Closed') {
      updated.acknowledgedAt = new Date();
      await this.prisma.case.update({ where: { id }, data: { acknowledgedAt: updated.acknowledgedAt } });
    }
    return { ...updated, sla: await this.sla.evaluate(updated, 'case') };
  }

  async closeCase(user: AuthUser, id: string, data: any) {
    const current = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!current) throw new NotFoundException('Case not found');
    const status = await this.resolveCaseStatus(user.organisationId, data.status || 'TruePositive');
    const updated = await this.prisma.case.update({
      where: { id },
      data: {
        statusId: status?.id,
        stage: 'Closed',
        endDate: new Date(),
        closedAt: new Date(),
        summary: data.summary ?? current.summary,
        customFields: data.customFields ?? current.customFields,
      },
      include: { status: true },
    });
    await this.prisma.caseTask.updateMany({
      where: { caseId: id, status: { in: ['Waiting', 'InProgress'] } },
      data: { status: 'Completed', endDate: new Date() },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'close',
      objectType: 'case',
      objectId: id,
      rootId: id,
      rootType: 'Case',
      details: {
        status: status?.value,
        stage: 'Closed',
        assigneeId: updated.assigneeId,
        previousAssigneeId: current.assigneeId,
        severity: updated.severity,
        tags: updated.tags,
        title: updated.title,
      },
    });
    return updated;
  }

  async reopenCase(user: AuthUser, id: string) {
    const current = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!current) throw new NotFoundException('Case not found');
    const status = await this.resolveCaseStatus(user.organisationId, 'InProgress');
    const updated = await this.prisma.case.update({
      where: { id },
      data: { statusId: status?.id, stage: 'InProgress', endDate: null, closedAt: null },
      include: { status: true },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'reopen',
      objectType: 'case',
      objectId: id,
      rootId: id,
      rootType: 'Case',
      details: { status: status?.value, stage: updated.stage, assigneeId: updated.assigneeId, severity: updated.severity, tags: updated.tags, title: updated.title },
    });
    return updated;
  }

  async deleteCase(user: AuthUser, id: string, force = false) {
    const current = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!current) throw new NotFoundException('Case not found');
    if (force) {
      const [observables, tasks, logs, pages] = await Promise.all([
        this.prisma.observable.findMany({ where: { caseId: id }, select: { id: true } }),
        this.prisma.caseTask.findMany({ where: { caseId: id }, select: { id: true } }),
        this.prisma.taskLog.findMany({ where: { caseId: id }, select: { id: true } }),
        this.prisma.page.findMany({ where: { caseId: id }, select: { id: true } }),
      ]);
      // Comments are polymorphic and have no FK, so they must be removed explicitly.
      const commentOwners = [
        { objectType: 'case', objectId: id },
        ...tasks.map((row) => ({ objectType: 'task', objectId: row.id })),
        ...logs.map((row) => ({ objectType: 'log', objectId: row.id })),
        ...observables.map((row) => ({ objectType: 'observable', objectId: row.id })),
        ...pages.map((row) => ({ objectType: 'page', objectId: row.id })),
      ];
      const comments = await this.prisma.comment.findMany({ where: { OR: commentOwners }, select: { id: true } });
      const attachmentOwners = [
        ...commentOwners,
        ...comments.map((row) => ({ objectType: 'comment', objectId: row.id })),
      ];
      if (comments.length) {
        await this.prisma.comment.deleteMany({ where: { id: { in: comments.map((row) => row.id) } } });
      }
      await this.prisma.case.delete({ where: { id } });
      await this.attachments.removeForOwners(attachmentOwners, user.id);
    } else {
      const status = await this.resolveCaseStatus(user.organisationId, 'Other');
      await this.prisma.case.update({ where: { id }, data: { stage: 'Closed', statusId: status?.id, closedAt: new Date() } });
    }
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: force ? 'force-delete' : 'delete',
      objectType: 'case',
      objectId: id,
      rootId: id,
      rootType: 'Case',
      details: { number: current.number, title: current.title, tags: current.tags, severity: current.severity, stage: current.stage },
      object: current,
    });
    return { ok: true };
  }

  async bulkUpdate(user: AuthUser, ids: string[], data: any) {
    const result = await this.prisma.case.updateMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      data: {
        severity: data.severity !== undefined ? Number(data.severity) : undefined,
        tlp: data.tlp !== undefined ? Number(data.tlp) : undefined,
        pap: data.pap !== undefined ? Number(data.pap) : undefined,
        flag: data.flag ?? undefined,
      },
    });
    if (data.addTags?.length || data.removeTags?.length) {
      for (const id of ids) {
        const c = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId } });
        if (c) {
          const merged = normaliseTags([
            ...(c.tags || []).filter((tag) => !(data.removeTags || []).includes(tag)),
            ...(data.addTags || []),
          ]);
          await this.prisma.case.update({ where: { id }, data: { tags: merged } });
        }
      }
    }
    for (const id of ids) {
      const c = await this.prisma.case.findFirst({ where: { id, organisationId: user.organisationId } });
      if (!c) continue;
      await this.audit.log({
        organisationId: user.organisationId,
        actorId: user.id,
        action: 'update',
        objectType: 'case',
        objectId: id,
        rootId: id,
        rootType: 'Case',
        details: { assigneeId: c.assigneeId, stage: c.stage, severity: c.severity, tags: c.tags, title: c.title, bulk: true },
      });
    }
    return result;
  }

  async mergeCases(user: AuthUser, ids: string[]) {
    if (!ids || ids.length < 2) throw new BadRequestException('At least two cases are required');
    const cases = await this.prisma.case.findMany({ where: { id: { in: ids }, organisationId: user.organisationId } });
    if (cases.length < 2) throw new BadRequestException('Cases not found');
    const first = cases[0];
    const title = `Merged case: ${cases.map((c) => `#${c.number}`).join(', ')}`;
    const created = await this.createCase(user, {
      title,
      description: cases.map((c) => `## #${c.number} ${c.title}\n\n${c.description}`).join('\n\n---\n\n'),
      severity: Math.max(...cases.map((c) => c.severity)),
      tlp: Math.max(...cases.map((c) => c.tlp)),
      pap: Math.max(...cases.map((c) => c.pap)),
      tags: Array.from(new Set(cases.flatMap((c) => c.tags || []))),
    });
    const duplicated = await this.resolveCaseStatus(user.organisationId, 'Duplicated');
    await this.prisma.$transaction(
      cases.flatMap((c) => [
        this.prisma.caseTask.updateMany({ where: { caseId: c.id }, data: { caseId: created.id } }),
        this.prisma.taskLog.updateMany({ where: { caseId: c.id }, data: { caseId: created.id } }),
        this.prisma.observable.updateMany({ where: { caseId: c.id }, data: { caseId: created.id } }),
        this.prisma.procedure.updateMany({ where: { caseId: c.id }, data: { caseId: created.id } }),
        this.prisma.alert.updateMany({ where: { caseId: c.id }, data: { caseId: created.id } }),
        this.prisma.comment.updateMany({ where: { objectType: 'case', objectId: c.id }, data: { objectId: created.id } }),
        this.prisma.attachment.updateMany({ where: { objectType: 'case', objectId: c.id }, data: { objectId: created.id } }),
        this.prisma.case.update({
          where: { id: c.id },
          data: { mergedIntoCaseId: created.id, stage: 'Closed', statusId: duplicated?.id ?? undefined, closedAt: new Date(), endDate: new Date() },
        }),
      ]),
    );
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'merge', objectType: 'case', objectId: created.id, rootId: created.id, rootType: 'Case', details: { sources: ids } });
    return this.getCase(user, created.id);
  }

  async listTasks(user: AuthUser, query: any) {
    const where: any = { organisationId: user.organisationId };
    if (query.caseId) where.caseId = query.caseId;
    if (query.status) where.status = query.status;
    if (query.assignee) where.assignee = { login: query.assignee };
    if (query.flag) where.flag = query.flag === 'true' || query.flag === true;
    if (query.group) where.group = query.group;
    if (query.search) where.title = { contains: query.search, mode: 'insensitive' };
    if (query.scope === 'mine') where.assigneeId = user.id;
    if (query.scope === 'waiting') where.status = 'Waiting';
    const page = Math.max(0, Number(query.page ?? 0));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 30)));
    const [items, total] = await this.prisma.$transaction([
      this.prisma.caseTask.findMany({
        where,
        include: {
          case: { select: { id: true, number: true, title: true } },
          assignee: { select: { id: true, login: true, name: true } },
          _count: { select: { logs: true } },
        },
        orderBy: [{ flag: 'desc' }, { createdAt: 'desc' }],
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.caseTask.count({ where }),
    ]);
    const rules = await this.sla.rulesFor(user.organisationId);
    return { items: this.sla.attach(items, 'task', rules), total, page, pageSize };
  }

  async getTask(user: AuthUser, id: string) {
    const task = await this.prisma.caseTask.findFirst({
      where: { id, organisationId: user.organisationId },
      include: {
        case: { select: { id: true, number: true, title: true } },
        assignee: { select: { id: true, login: true, name: true } },
        logs: {
          include: { createdBy: { select: { id: true, login: true, name: true } } },
          orderBy: { date: 'asc' },
        },
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    return { ...task, sla: await this.sla.evaluate(task, 'task') };
  }

  async createTask(user: AuthUser, caseId: string, data: any) {
    const c = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId } });
    if (!c) throw new NotFoundException('Case not found');
    if (!data.title?.trim()) throw new BadRequestException('title is required');
    const initialStatus = data.status || 'Waiting';
    const task = await this.prisma.caseTask.create({
      data: {
        organisationId: user.organisationId,
        caseId,
        title: data.title,
        group: data.group || null,
        description: data.description || '',
        status: initialStatus,
        acknowledgedAt: initialStatus === 'InProgress' ? new Date() : null,
        flag: !!data.flag,
        mandatory: !!data.mandatory,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        order: data.order ?? 0,
        assigneeId: data.assignee ? await this.resolveUserId(data.assignee, user.organisationId) : null,
      },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'create', objectType: 'task', objectId: task.id, rootId: caseId, rootType: 'Case', details: { caseId, assigneeId: task.assigneeId, status: task.status, title: task.title } });
    return task;
  }

  async updateTask(user: AuthUser, id: string, data: any) {
    const task = await this.prisma.caseTask.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!task) throw new NotFoundException('Task not found');
    const updated = await this.prisma.caseTask.update({
      where: { id },
      data: {
        title: data.title ?? undefined,
        group: data.group ?? undefined,
        description: data.description ?? undefined,
        status: data.status ?? undefined,
        flag: data.flag ?? undefined,
        mandatory: data.mandatory ?? undefined,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: optionalDate(data.endDate),
        dueDate: optionalDate(data.dueDate),
        assigneeId: data.assignee !== undefined ? (data.assignee ? await this.resolveUserId(data.assignee, user.organisationId) : null) : undefined,
      },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'task',
      objectId: id,
      rootId: task.caseId,
      rootType: 'Case',
      details: {
        caseId: task.caseId,
        assigneeId: updated.assigneeId,
        previousAssigneeId: task.assigneeId,
        status: updated.status,
        previousStatus: task.status,
        title: updated.title,
      },
    });
    if (!task.acknowledgedAt && updated.status === 'InProgress') {
      updated.acknowledgedAt = new Date();
      await this.prisma.caseTask.update({ where: { id }, data: { acknowledgedAt: updated.acknowledgedAt } });
    }
    return { ...updated, sla: await this.sla.evaluate(updated, 'task') };
  }

  async deleteTask(user: AuthUser, id: string) {
    const task = await this.prisma.caseTask.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!task) throw new NotFoundException('Task not found');
    const updated = await this.prisma.caseTask.update({ where: { id }, data: { status: 'Cancel' } });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'delete',
      objectType: 'task',
      objectId: id,
      rootId: task.caseId,
      rootType: 'Case',
      details: { caseId: task.caseId, assigneeId: task.assigneeId, previousStatus: task.status, status: updated.status, title: task.title },
      object: task,
    });
    return { ok: true };
  }

  async bulkTasks(user: AuthUser, ids: string[], data: any) {
    const result = await this.prisma.caseTask.updateMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      data: { status: data.status ?? undefined, flag: data.flag ?? undefined },
    });
    if (data.status === 'InProgress') {
      await this.prisma.caseTask.updateMany({
        where: { id: { in: ids }, organisationId: user.organisationId, acknowledgedAt: null },
        data: { acknowledgedAt: new Date() },
      });
    }
    const tasks = await this.prisma.caseTask.findMany({ where: { id: { in: ids }, organisationId: user.organisationId } });
    for (const task of tasks) {
      await this.audit.log({
        organisationId: user.organisationId,
        actorId: user.id,
        action: 'update',
        objectType: 'task',
        objectId: task.id,
        rootId: task.caseId,
        rootType: 'Case',
        details: { caseId: task.caseId, assigneeId: task.assigneeId, status: task.status, title: task.title, bulk: true },
      });
    }
    return result;
  }

  async taskActionRequired(user: AuthUser, id: string) {
    const task = await this.prisma.caseTask.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!task) throw new NotFoundException('Task not found');
    return { actionRequired: task.flag };
  }

  async setTaskAction(user: AuthUser, id: string, required: boolean) {
    const task = await this.prisma.caseTask.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!task) throw new NotFoundException('Task not found');
    const updated = await this.prisma.caseTask.update({ where: { id }, data: { flag: required } });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'task',
      objectId: id,
      rootId: task.caseId,
      rootType: 'Case',
      details: { caseId: task.caseId, assigneeId: task.assigneeId, status: task.status, flag: required, title: task.title },
    });
    return updated;
  }

  async createLog(user: AuthUser, taskId: string, data: any) {
    const task = await this.prisma.caseTask.findFirst({ where: { id: taskId, organisationId: user.organisationId } });
    if (!task) throw new NotFoundException('Task not found');
    if (!data.message?.trim()) throw new BadRequestException('message is required');
    const log = await this.prisma.taskLog.create({
      data: {
        organisationId: user.organisationId,
        taskId,
        caseId: task.caseId,
        message: data.message,
        date: data.date ? new Date(data.date) : data.startDate ? new Date(data.startDate) : new Date(),
        includeInTimeline: data.includeInTimeline !== false,
        createdById: user.id,
      },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    if (task.status === 'Waiting') {
      await this.prisma.caseTask.update({
        where: { id: taskId },
        data: { status: 'InProgress', startDate: task.startDate || new Date(), acknowledgedAt: task.acknowledgedAt || new Date() },
      });
    }
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'create',
      objectType: 'log',
      objectId: log.id,
      rootId: task.caseId,
      rootType: 'Case',
      details: { caseId: task.caseId, taskId, taskAssigneeId: task.assigneeId, message: log.message },
      object: log,
    });
    return log;
  }

  async updateLog(user: AuthUser, id: string, data: any) {
    const existing = await this.prisma.taskLog.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Log not found');
    const log = await this.prisma.taskLog.update({
      where: { id },
      data: { message: data.message ?? undefined, date: data.date ? new Date(data.date) : undefined },
    });
    const task = await this.prisma.caseTask.findUnique({ where: { id: log.taskId } });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'log',
      objectId: id,
      rootId: log.caseId,
      rootType: 'Case',
      details: { caseId: log.caseId, taskId: log.taskId, taskAssigneeId: task?.assigneeId, message: log.message },
    });
    return log;
  }

  async deleteLog(user: AuthUser, id: string) {
    const existing = await this.prisma.taskLog.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Log not found');
    const task = await this.prisma.caseTask.findUnique({ where: { id: existing.taskId } });
    const comments = await this.prisma.comment.findMany({ where: { objectType: 'log', objectId: id }, select: { id: true } });
    if (comments.length) await this.prisma.comment.deleteMany({ where: { id: { in: comments.map((row) => row.id) } } });
    await this.prisma.taskLog.delete({ where: { id } });
    await this.attachments.removeForOwners([
      { objectType: 'log', objectId: id },
      ...comments.map((row) => ({ objectType: 'comment', objectId: row.id })),
    ], user.id);
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'delete',
      objectType: 'log',
      objectId: id,
      rootId: existing.caseId,
      rootType: 'Case',
      details: { caseId: existing.caseId, taskId: existing.taskId, taskAssigneeId: task?.assigneeId, message: existing.message },
      object: existing,
    });
    return { ok: true };
  }

  async listObservables(user: AuthUser, query: any) {
    const where: any = { organisationId: user.organisationId };
    if (query.caseId) where.caseId = query.caseId;
    if (query.alertId) where.alertId = query.alertId;
    if (query.dataType) where.dataType = query.dataType;
    if (query.ioc !== undefined) where.ioc = query.ioc === 'true' || query.ioc === true;
    if (query.sighted !== undefined) where.sighted = query.sighted === 'true' || query.sighted === true;
    if (query.search) where.OR = [{ data: { contains: query.search, mode: 'insensitive' } }, { message: { contains: query.search, mode: 'insensitive' } }];
    const page = Math.max(0, Number(query.page ?? 0));
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize ?? 100)));
    const [items, total] = await this.prisma.$transaction([
      this.prisma.observable.findMany({ where, include: { attachment: true }, orderBy: { createdAt: 'desc' }, skip: page * pageSize, take: pageSize }),
      this.prisma.observable.count({ where }),
    ]);
    return {
      items: await Promise.all(items.map(async (observable) => ({
        ...observable,
        attachment: observable.attachment ? await this.attachments.withHashes(observable.attachment) : null,
      }))),
      total,
      page,
      pageSize,
    };
  }

  /** Uploads one or more files and creates `file` observables (+ md5/sha1/sha256 hash observables). */
  async createFileObservables(user: AuthUser, scope: { caseId?: string; alertId?: string }, files: any[], body: any = {}) {
    const caseId = scope.caseId || null;
    const alertId = scope.alertId || null;
    if (!caseId && !alertId) throw new BadRequestException('caseId or alertId is required');
    if (caseId) {
      const found = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId }, select: { id: true } });
      if (!found) throw new NotFoundException('Case not found');
    }
    if (alertId) {
      const found = await this.prisma.alert.findFirst({ where: { id: alertId, organisationId: user.organisationId }, select: { id: true } });
      if (!found) throw new NotFoundException('Alert not found');
    }
    if (!Array.isArray(files) || !files.length) throw new BadRequestException('file is required');

    const maxMb = Number(process.env.MAX_UPLOAD_MB || 50) || 50;
    const maxBytes = maxMb * 1024 * 1024;
    const addHashes = parseBoolean(body?.addHashes, true);
    const message = body?.message ? String(body.message) : null;
    const tlp = Number(body?.tlp ?? 2);
    const pap = Number(body?.pap ?? 2);
    const ioc = parseBoolean(body?.ioc, false);
    const tags = parseTags(body?.tags);
    const scopeWhere = caseId ? { caseId } : { alertId };

    const filesResult: any[] = [];
    const allObservables: any[] = [];
    for (const file of files) {
      if (!file?.buffer || !file?.originalname) throw new BadRequestException('Invalid uploaded file');
      if (file.size > maxBytes) throw new PayloadTooLargeException(`El fichero supera el tamaño máximo de ${maxMb} MB`);
      const md5 = createHash('md5').update(file.buffer).digest('hex');
      const sha1 = createHash('sha1').update(file.buffer).digest('hex');
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');

      const created = await this.prisma.observable.create({
        data: {
          organisationId: user.organisationId,
          caseId,
          alertId,
          dataType: 'file',
          data: file.originalname,
          dataHash: sha256,
          message,
          tlp,
          pap,
          ioc,
          tags,
          createdById: user.id,
        },
      });
      await this.auditObservable(user, 'create', created, { file: true, attachment: true });
      const attachment = await this.attachments.upload(user, file, { objectType: 'observable', objectId: created.id });
      const observable = await this.prisma.observable.update({
        where: { id: created.id },
        data: { attachmentId: attachment.id },
        include: { attachment: true },
      });

      const hashObservables: any[] = [];
      if (addHashes) {
        for (const value of [md5, sha1, sha256]) {
          const dataHash = createHash('sha256').update(`hash:${value.toLowerCase()}`).digest('hex');
          const exists = await this.prisma.observable.findFirst({ where: { organisationId: user.organisationId, ...scopeWhere, dataHash }, select: { id: true } });
          if (exists) continue;
          const hashObservable = await this.prisma.observable.create({
            data: {
              organisationId: user.organisationId,
              caseId,
              alertId,
              dataType: 'hash',
              data: value,
              dataHash,
              message: `Hash de ${file.originalname}`,
              tlp,
              pap,
              ioc,
              tags,
              createdById: user.id,
            },
          });
          await this.auditObservable(user, 'create', hashObservable, { file: false, parentFile: file.originalname });
          hashObservables.push(hashObservable);
        }
      }
      const decorated = { ...observable, attachment: await this.attachments.withHashes(observable.attachment) };
      filesResult.push({ observable: decorated, attachment: decorated.attachment, hashes: { md5, sha1, sha256 }, hashObservables });
      allObservables.push(decorated, ...hashObservables);
    }
    return { files: filesResult, observables: allObservables };
  }

  async getObservableDownload(user: AuthUser, id: string) {
    const observable = await this.prisma.observable.findFirst({
      where: { id, organisationId: user.organisationId },
      include: { attachment: true },
    });
    if (!observable) throw new NotFoundException('Observable not found');
    if (!observable.attachment) throw new NotFoundException('This observable has no file attached');
    const { path } = await this.attachments.getForDownload(observable.attachment.id);
    return { observable, attachment: observable.attachment, path };
  }

  private async auditObservable(user: AuthUser, action: string, observable: any, details: any = {}) {
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action,
      objectType: 'observable',
      objectId: observable.id,
      rootId: observable.caseId || observable.alertId,
      rootType: observable.caseId ? 'Case' : observable.alertId ? 'Alert' : null,
      details: {
        caseId: observable.caseId,
        alertId: observable.alertId,
        dataType: observable.dataType,
        data: observable.data,
        tags: observable.tags,
        tlp: observable.tlp,
        pap: observable.pap,
        ...details,
      },
      object: observable,
    });
  }

  async createObservable(user: AuthUser, data: any) {
    if (!data.dataType || data.data === undefined) throw new BadRequestException('dataType and data are required');
    if (data.caseId) {
      const c = await this.prisma.case.findFirst({ where: { id: data.caseId, organisationId: user.organisationId } });
      if (!c) throw new NotFoundException('Case not found');
    }
    const dataHash = createHash('sha256').update(`${data.dataType}:${String(data.data).toLowerCase()}`).digest('hex');
    const observable = await this.prisma.observable.create({
      data: {
        organisationId: user.organisationId,
        caseId: data.caseId || null,
        alertId: data.alertId || null,
        dataType: data.dataType,
        data: String(data.data),
        dataHash,
        message: data.message || null,
        tlp: Number(data.tlp ?? 2),
        pap: Number(data.pap ?? 2),
        ioc: !!data.ioc,
        sighted: !!data.sighted,
        sightedAt: data.sightedAt ? new Date(data.sightedAt) : null,
        ignoreSimilarity: !!data.ignoreSimilarity,
        tags: data.tags || [],
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        createdById: user.id,
      },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'create',
      objectType: 'observable',
      objectId: observable.id,
      rootId: observable.caseId || observable.alertId,
      rootType: observable.caseId ? 'Case' : observable.alertId ? 'Alert' : null,
      details: {
        caseId: observable.caseId,
        alertId: observable.alertId,
        dataType: observable.dataType,
        data: observable.data,
        tags: observable.tags,
        tlp: observable.tlp,
        pap: observable.pap,
      },
      object: observable,
    });
    return observable;
  }

  async createObservablesBulk(user: AuthUser, data: any) {
    const items = Array.isArray(data.items) ? data.items : [];
    const created = [];
    for (const item of items) {
      created.push(await this.createObservable(user, { ...item, caseId: data.caseId, alertId: data.alertId }));
    }
    return created;
  }

  async updateObservable(user: AuthUser, id: string, data: any) {
    const existing = await this.prisma.observable.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Observable not found');
    const observable = await this.prisma.observable.update({
      where: { id },
      data: {
        dataType: data.dataType ?? undefined,
        data: data.data ?? undefined,
        message: data.message ?? undefined,
        tlp: data.tlp !== undefined ? Number(data.tlp) : undefined,
        pap: data.pap !== undefined ? Number(data.pap) : undefined,
        ioc: data.ioc ?? undefined,
        sighted: data.sighted ?? undefined,
        sightedAt: data.sightedAt ? new Date(data.sightedAt) : undefined,
        ignoreSimilarity: data.ignoreSimilarity ?? undefined,
        tags: data.tags ?? undefined,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
      },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'observable',
      objectId: id,
      rootId: observable.caseId || observable.alertId,
      rootType: observable.caseId ? 'Case' : observable.alertId ? 'Alert' : null,
      details: {
        caseId: observable.caseId,
        alertId: observable.alertId,
        dataType: observable.dataType,
        data: observable.data,
        tags: observable.tags,
        tlp: observable.tlp,
        pap: observable.pap,
      },
    });
    return observable;
  }

  async deleteObservable(user: AuthUser, id: string) {
    const existing = await this.prisma.observable.findFirst({ where: { id, organisationId: user.organisationId }, include: { attachment: true } });
    if (!existing) throw new NotFoundException('Observable not found');
    const comments = await this.prisma.comment.findMany({ where: { objectType: 'observable', objectId: id }, select: { id: true } });
    if (comments.length) await this.prisma.comment.deleteMany({ where: { id: { in: comments.map((row) => row.id) } } });
    if (existing.attachmentId) await this.attachments.remove(existing.attachmentId, user.id);
    await this.attachments.removeForOwners(comments.map((row) => ({ objectType: 'comment', objectId: row.id })), user.id);
    await this.prisma.observable.delete({ where: { id } });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'delete',
      objectType: 'observable',
      objectId: id,
      rootId: existing.caseId || existing.alertId,
      rootType: existing.caseId ? 'Case' : existing.alertId ? 'Alert' : null,
      details: {
        caseId: existing.caseId,
        alertId: existing.alertId,
        dataType: existing.dataType,
        data: existing.data,
        tags: existing.tags,
        tlp: existing.tlp,
        pap: existing.pap,
      },
      object: existing,
    });
    return { ok: true };
  }

  async bulkObservables(user: AuthUser, ids: string[], data: any) {
    const result = await this.prisma.observable.updateMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      data: {
        tlp: data.tlp !== undefined ? Number(data.tlp) : undefined,
        pap: data.pap !== undefined ? Number(data.pap) : undefined,
        ioc: data.ioc ?? undefined,
        sighted: data.sighted ?? undefined,
      },
    });
    const observables = await this.prisma.observable.findMany({ where: { id: { in: ids }, organisationId: user.organisationId } });
    for (const observable of observables) {
      await this.audit.log({
        organisationId: user.organisationId,
        actorId: user.id,
        action: 'update',
        objectType: 'observable',
        objectId: observable.id,
        rootId: observable.caseId || observable.alertId,
        rootType: observable.caseId ? 'Case' : observable.alertId ? 'Alert' : null,
        details: { caseId: observable.caseId, alertId: observable.alertId, dataType: observable.dataType, data: observable.data, tags: observable.tags, tlp: observable.tlp, pap: observable.pap, bulk: true },
      });
    }
    return result;
  }

  async mergeObservables(user: AuthUser, caseId: string) {
    const observables = await this.prisma.observable.findMany({ where: { caseId, organisationId: user.organisationId } });
    const byHash = new Map<string, any[]>();
    for (const o of observables) {
      const key = o.dataHash || `${o.dataType}:${o.data.toLowerCase()}`;
      byHash.set(key, [...(byHash.get(key) || []), o]);
    }
    let removed = 0;
    const duplicateAttachmentIds: string[] = [];
    for (const group of byHash.values()) {
      if (group.length < 2) continue;
      const [keep, ...dupes] = group;
      duplicateAttachmentIds.push(...dupes.map((item) => item.attachmentId).filter(Boolean));
      await this.prisma.$transaction([
        this.prisma.observable.update({
          where: { id: keep.id },
          data: {
            ioc: group.some((o) => o.ioc),
            sighted: group.some((o) => o.sighted),
            sightedAt: group.map((o) => o.sightedAt).filter(Boolean).sort()[0] ?? keep.sightedAt,
            tags: normaliseTags(group.flatMap((o) => o.tags || [])),
            message: Array.from(new Set(group.map((o) => o.message).filter(Boolean))).join(' / ') || null,
          },
        }),
        this.prisma.observableReport.updateMany({ where: { observableId: { in: dupes.map((d) => d.id) } }, data: { observableId: keep.id } }),
        this.prisma.observable.deleteMany({ where: { id: { in: dupes.map((d) => d.id) } } }),
      ]);
      removed += dupes.length;
    }
    if (duplicateAttachmentIds.length) await this.attachments.removeByIds(duplicateAttachmentIds, user.id);
    return { removed, remaining: observables.length - removed };
  }

  async addObservableReport(user: AuthUser, id: string, data: any) {
    return this.prisma.observableReport.create({
      data: { observableId: id, analyzer: data.analyzer || 'Mock analyzer', report: data.report || { status: 'success' } },
    });
  }

  async listProcedures(user: AuthUser, query: any) {
    const where: any = { organisationId: user.organisationId };
    if (query.caseId) where.caseId = query.caseId;
    if (query.alertId) where.alertId = query.alertId;
    const rows = await this.prisma.procedure.findMany({ where, orderBy: { occurDate: 'desc' } });
    return attachPatterns(this.prisma, rows);
  }

  async procedureStats(user: AuthUser, query: any) {
    const days = Math.max(1, Math.min(3650, Number(query.days ?? 90) || 90));
    const since = new Date(Date.now() - days * 86400000);
    const rows = await this.prisma.procedure.findMany({
      where: { organisationId: user.organisationId, caseId: { not: null }, occurDate: { gte: since } },
      select: { patternId: true, patternName: true, tactic: true, caseId: true },
    });
    const byPattern = new Map<string, { patternId: string; patternName: string | null; tactic: string | null; cases: Set<string> }>();
    for (const row of rows) {
      const entry = byPattern.get(row.patternId) || {
        patternId: row.patternId,
        patternName: row.patternName,
        tactic: row.tactic,
        cases: new Set<string>(),
      };
      if (!entry.patternName && row.patternName) entry.patternName = row.patternName;
      if (!entry.tactic && row.tactic) entry.tactic = row.tactic;
      if (row.caseId) entry.cases.add(row.caseId);
      byPattern.set(row.patternId, entry);
    }
    const items = Array.from(byPattern.values())
      .map((entry) => ({ patternId: entry.patternId, patternName: entry.patternName, tactic: entry.tactic, caseCount: entry.cases.size }))
      .sort((a, b) => b.caseCount - a.caseCount || a.patternId.localeCompare(b.patternId))
      .slice(0, 10);
    return { days, items };
  }

  async createProcedure(user: AuthUser, data: any) {
    if (!data.patternId) throw new BadRequestException('patternId is required');
    const enriched = await enrichProcedureInput(this.prisma, data);
    const procedure = await this.prisma.procedure.create({
      data: {
        organisationId: user.organisationId,
        caseId: data.caseId || null,
        alertId: data.alertId || null,
        patternId: data.patternId,
        patternName: enriched.patternName || data.patternName || data.patternId,
        tactic: enriched.tactic || null,
        occurDate: data.occurDate ? new Date(data.occurDate) : new Date(),
        description: data.description || '',
        createdById: user.id,
      },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'create',
      objectType: 'procedure',
      objectId: procedure.id,
      rootId: procedure.caseId || procedure.alertId,
      rootType: procedure.caseId ? 'Case' : procedure.alertId ? 'Alert' : null,
      details: { caseId: procedure.caseId, alertId: procedure.alertId, patternId: procedure.patternId, patternName: procedure.patternName, tactic: procedure.tactic },
      object: procedure,
    });
    return attachPatterns(this.prisma, [procedure]).then((rows) => rows[0]);
  }

  async updateProcedure(user: AuthUser, id: string, data: any) {
    const existing = await this.prisma.procedure.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Procedure not found');
    const patternChanged = data.patternId !== undefined && data.patternId !== existing.patternId;
    const enriched = await enrichProcedureInput(this.prisma, {
      patternId: data.patternId ?? existing.patternId,
      patternName:
        data.patternName !== undefined
          ? data.patternName
          : patternChanged
            ? undefined
            : existing.patternName,
      tactic: patternChanged ? data.tactic ?? null : data.tactic !== undefined ? data.tactic : existing.tactic,
    });
    const refreshPattern = data.patternId !== undefined || data.patternName !== undefined || data.tactic !== undefined;
    const procedure = await this.prisma.procedure.update({
      where: { id },
      data: {
        tactic: refreshPattern ? enriched.tactic || null : undefined,
        occurDate: data.occurDate ? new Date(data.occurDate) : undefined,
        description: data.description ?? undefined,
        patternId: data.patternId ?? undefined,
        patternName: refreshPattern ? enriched.patternName : undefined,
      },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'procedure',
      objectId: id,
      rootId: procedure.caseId || procedure.alertId,
      rootType: procedure.caseId ? 'Case' : procedure.alertId ? 'Alert' : null,
      details: { caseId: procedure.caseId, alertId: procedure.alertId, patternId: procedure.patternId, patternName: procedure.patternName, tactic: procedure.tactic },
    });
    return attachPatterns(this.prisma, [procedure]).then((rows) => rows[0]);
  }

  async deleteProcedure(user: AuthUser, id: string) {
    const existing = await this.prisma.procedure.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Procedure not found');
    await this.prisma.procedure.delete({ where: { id } });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'delete',
      objectType: 'procedure',
      objectId: id,
      rootId: existing.caseId || existing.alertId,
      rootType: existing.caseId ? 'Case' : existing.alertId ? 'Alert' : null,
      details: { caseId: existing.caseId, alertId: existing.alertId, patternId: existing.patternId, patternName: existing.patternName, tactic: existing.tactic },
      object: existing,
    });
    return { ok: true };
  }

  async listComments(user: AuthUser, objectType: string, objectId: string) {
    return this.prisma.comment.findMany({
      where: { organisationId: user.organisationId, objectType, objectId },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createComment(user: AuthUser, data: any) {
    if (!data.message?.trim()) throw new BadRequestException('message is required');
    const comment = await this.prisma.comment.create({
      data: {
        organisationId: user.organisationId,
        objectType: data.objectType || 'case',
        objectId: data.objectId,
        message: data.message,
        createdById: user.id,
      },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'create',
      objectType: 'comment',
      objectId: comment.id,
      rootId: comment.objectId,
      rootType: comment.objectType,
      details: { objectType: comment.objectType, objectId: comment.objectId, message: comment.message, caseId: comment.objectType === 'case' ? comment.objectId : undefined },
      object: comment,
    });
    return comment;
  }

  async updateComment(user: AuthUser, id: string, data: any) {
    const comment = await this.prisma.comment.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (!data.message?.trim()) throw new BadRequestException('message is required');
    const updated = await this.prisma.comment.update({
      where: { id },
      data: { message: data.message },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'update',
      objectType: 'comment',
      objectId: id,
      rootId: comment.objectId,
      rootType: comment.objectType,
      details: { objectType: comment.objectType, objectId: comment.objectId, message: updated.message, caseId: comment.objectType === 'case' ? comment.objectId : undefined },
    });
    return updated;
  }

  async deleteComment(user: AuthUser, id: string) {
    const comment = await this.prisma.comment.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!comment) throw new NotFoundException('Comment not found');
    await this.prisma.comment.delete({ where: { id } });
    await this.attachments.removeForOwners([{ objectType: 'comment', objectId: id }], user.id);
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'delete',
      objectType: 'comment',
      objectId: id,
      rootId: comment.objectId,
      rootType: comment.objectType,
      details: { objectType: comment.objectType, objectId: comment.objectId, message: comment.message, caseId: comment.objectType === 'case' ? comment.objectId : undefined },
      object: comment,
    });
    return { ok: true };
  }

  async timeline(user: AuthUser, caseId: string) {
    const c = await this.prisma.case.findFirst({
      where: { id: caseId, organisationId: user.organisationId },
      include: {
        tasks: { include: { logs: true } },
        observables: true,
        procedures: true,
      },
    });
    if (!c) throw new NotFoundException('Case not found');
    const comments = await this.prisma.comment.findMany({ where: { objectType: 'case', objectId: caseId } });
    const events: any[] = [];
    events.push({ type: 'case-created', date: c.createdAt, title: `Case #${c.number} created`, actor: c.createdById });
    for (const t of c.tasks) {
      events.push({ type: 'task-created', date: t.createdAt, title: `Task created: ${t.title}`, actor: null });
      for (const l of t.logs) {
        events.push({ type: 'task-log', date: l.date, title: l.message.slice(0, 160), actor: l.createdById, task: t.title });
      }
    }
    for (const o of c.observables) {
      events.push({ type: 'observable', date: o.createdAt, title: `${o.dataType}: ${o.data}`, actor: o.createdById });
    }
    for (const p of c.procedures) {
      events.push({ type: 'ttp', date: p.occurDate, title: `${p.patternId} ${p.patternName || ''}`, actor: p.createdById });
    }
    for (const cm of comments) {
      events.push({ type: 'comment', date: cm.createdAt, title: cm.message.slice(0, 160), actor: cm.createdById });
    }
    return events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  /**
   * TheHive 5 timeline shape: `{ events: [{ date, kind, entity, entityId, details }] }`,
   * newest first, combining audit log entries with task/log/observable creation dates.
   */
  async thehiveTimeline(user: AuthUser, caseId: string) {
    const c = await this.prisma.case.findFirst({
      where: { id: caseId, organisationId: user.organisationId },
      include: {
        tasks: { include: { logs: true } },
        observables: true,
        procedures: true,
        alerts: true,
      },
    });
    if (!c) throw new NotFoundException('Case not found');
    const comments = await this.prisma.comment.findMany({ where: { organisationId: user.organisationId, objectType: 'case', objectId: caseId } });
    const events: any[] = [];
    const add = (date: any, kind: string, entity: string, entityId: string, details: any) => {
      const value = date instanceof Date ? date.getTime() : typeof date === 'number' ? date : Date.parse(String(date));
      events.push({ date: Number.isNaN(value) ? Date.now() : value, kind, entity, entityId, details: details || {} });
    };

    add(c.createdAt, 'case-created', 'case', c.id, { number: c.number, title: c.title });
    for (const t of c.tasks) {
      add(t.createdAt, 'task-created', 'task', t.id, { title: t.title, group: t.group, status: t.status });
      for (const l of t.logs) {
        add(l.date, 'task-log', 'log', l.id, { message: l.message, taskId: t.id, taskTitle: t.title });
      }
    }
    for (const o of c.observables) {
      add(o.createdAt, 'observable-created', 'observable', o.id, { dataType: o.dataType, data: o.data, message: o.message });
    }
    for (const p of c.procedures) {
      add(p.occurDate, 'procedure-created', 'procedure', p.id, { patternId: p.patternId, patternName: p.patternName, tactic: p.tactic });
    }
    for (const cm of comments) {
      add(cm.createdAt, 'comment-created', 'comment', cm.id, { message: cm.message });
    }
    for (const a of c.alerts) {
      add(a.createdAt, 'alert-linked', 'alert', a.id, { title: a.title, stage: a.stage });
    }

    const objectIds = new Set<string>([c.id, ...c.tasks.map((t) => t.id), ...c.tasks.flatMap((t) => t.logs.map((l) => l.id)), ...c.observables.map((o) => o.id)]);
    const auditLogs = await this.prisma.auditLog.findMany({
      where: { organisationId: user.organisationId },
      include: { actor: { select: { login: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    for (const log of auditLogs) {
      const details = (log.details as any) || {};
      if (!log.objectId || (!objectIds.has(log.objectId) && details.caseId !== c.id)) continue;
      add(log.createdAt, `audit:${log.action}`, log.objectType, log.objectId, { ...details, actor: log.actor?.login ?? null });
    }

    events.sort((a, b) => b.date - a.date);
    return { events };
  }



  async listShares(user: AuthUser, caseId: string) {
    return this.prisma.share.findMany({
      where: { objectType: 'case', objectId: caseId },
      include: { targetOrg: true, profile: true, createdBy: { select: { id: true, login: true, name: true } } },
    });
  }

  async addShare(user: AuthUser, caseId: string, data: any) {
    const c = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId } });
    if (!c) throw new NotFoundException('Case not found');
    const org = await this.prisma.organisation.findFirst({ where: { OR: [{ id: data.organisation }, { name: data.organisation }] } });
    const profile = await this.prisma.profile.findUnique({ where: { name: data.profile || 'read-only' } });
    if (!org || !profile) throw new BadRequestException('Organisation or profile not found');
    if (org.id === user.organisationId) throw new BadRequestException('Cannot share with the same organisation');
    return this.prisma.share.create({
      data: { ownerOrgId: user.organisationId, sharedWithOrgId: org.id, objectType: 'case', objectId: caseId, profileId: profile.id, createdById: user.id },
      include: { targetOrg: true, profile: true },
    });
  }

  async removeShare(user: AuthUser, caseId: string, shareId: string) {
    await this.prisma.share.deleteMany({ where: { id: shareId, objectType: 'case', objectId: caseId, ownerOrgId: user.organisationId } });
    return { ok: true };
  }

  async listReports(user: AuthUser, caseId: string) {
    return this.prisma.caseReport.findMany({ where: { caseId, organisationId: user.organisationId }, orderBy: { createdAt: 'desc' } });
  }

  async generateReport(user: AuthUser, caseId: string) {
    const c = await this.getCase(user, caseId);
    const [logs, timeline] = await Promise.all([
      this.prisma.taskLog.findMany({
        where: { caseId: c.id, organisationId: user.organisationId },
        include: {
          createdBy: { select: { name: true } },
          task: { select: { id: true, title: true } },
        },
        orderBy: { date: 'asc' },
      }),
      this.timeline(user, c.id),
    ]);

    const formatDate = (value: any) => {
      if (!value) return '—';
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 19).replace('T', ' ');
    };
    const severityLabel = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' }[Number(c.severity)] || String(c.severity);
    const tlpLabel = { 0: 'WHITE', 1: 'GREEN', 2: 'AMBER', 3: 'RED' }[Number(c.tlp)] || String(c.tlp);
    const papLabel = { 0: 'WHITE', 1: 'GREEN', 2: 'AMBER', 3: 'RED' }[Number(c.pap)] || String(c.pap);
    const cell = (value: any) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

    const logsByTask = new Map<string, any[]>();
    for (const log of logs) {
      if (!logsByTask.has(log.taskId)) logsByTask.set(log.taskId, []);
      logsByTask.get(log.taskId)!.push(log);
    }

    const tasks = (c.tasks || []).map((task: any) => {
      const taskLogs = logsByTask.get(task.id) || [];
      const lines = [
        `### ${task.status === 'Completed' ? '[x]' : '[ ]'} ${task.title}`,
        '',
        `- **Status:** ${task.status}${task.group ? ` · **Group:** ${task.group}` : ''}${task.assignee?.name ? ` · **Assignee:** ${task.assignee.name}` : ''}`,
        `- **Due date:** ${formatDate(task.dueDate)}`,
      ];
      if (task.description) lines.push('', task.description);
      if (taskLogs.length) {
        lines.push('', '**Logs:**');
        for (const log of taskLogs) {
          lines.push(`- ${formatDate(log.date)}${log.createdBy?.name ? ` · ${log.createdBy.name}` : ''} — ${cell(log.message)}`);
        }
      }
      return lines.join('\n');
    }).join('\n\n');

    const observables = (c.observables || []).map((observable: any) => {
      const analysis = (observable.reports || [])
        .flatMap((report: any) => (report.taxonomies || []).map((taxonomy: any) => (
          `${report.analyzer}: ${taxonomy.namespace}:${taxonomy.predicate}=${taxonomy.value}`
        )))
        .join('; ');
      return `| ${cell(observable.dataType)} | \`${cell(observable.data)}\` | ${observable.ioc ? 'yes' : 'no'} | ${cell(observable.message)} | ${cell(analysis || '—')} |`;
    }).join('\n');

    const ttps = (c.procedures || [])
      .map((ttp: any) => `- **${ttp.patternId}** ${ttp.patternName || ''}${ttp.tactic ? ` — ${ttp.tactic}` : ''}`)
      .join('\n');

    const timelineLines = (timeline || [])
      .map((event: any) => `- ${formatDate(event.date)} — **${event.type}** ${cell(event.title)}${event.task ? ` (task: ${event.task})` : ''}`)
      .join('\n');

    const comments = (c.comments || [])
      .map((comment: any) => `**${comment.createdBy?.name || 'User'}** · ${formatDate(comment.createdAt)}\n\n> ${cell(comment.message)}`)
      .join('\n\n');

    const content = `# Case #${c.number}: ${c.title}

| | |
|---|---|
| **Status** | ${c.status?.value || c.stage} |
| **Severity** | ${severityLabel} (${c.severity}) |
| **TLP / PAP** | TLP.${tlpLabel} / PAP.${papLabel} |
| **Assignee** | ${cell(c.assignee?.name || '—')} |
| **Created** | ${formatDate(c.startDate || c.createdAt)} |
| **Closed** | ${formatDate(c.endDate)} |
| **Due date** | ${formatDate(c.dueDate)} |
| **Tags** | ${cell((c.tags || []).join(', ') || '—')} |

## Summary

${c.summary || c.description || 'No summary.'}

## Tasks

${tasks || 'No tasks.'}

## Observables

${observables ? `| Type | Value | IOC | Message | Analysis |\n|---|---|---|---|---|\n${observables}` : 'No observables.'}

## TTPs

${ttps || 'No TTPs.'}

## Timeline

${timelineLines || 'No timeline events.'}

## Comments

${comments || 'No comments.'}

---
Generated by Nuestracolmena on ${new Date().toISOString()}
`;
    return this.prisma.caseReport.create({
      data: { organisationId: user.organisationId, caseId: c.id, content, renderedAt: new Date(), createdById: user.id },
    });
  }

  async stats(user: AuthUser) {
    const organisationId = user.organisationId;
    const cases = await this.prisma.case.findMany({ where: { organisationId }, select: { stage: true, severity: true, status: { select: { value: true } }, tags: true } });
    const tasks = await this.prisma.caseTask.groupBy({ by: ['status'], where: { organisationId }, _count: true });
    const observables = await this.prisma.observable.groupBy({ by: ['dataType'], where: { organisationId }, _count: true });
    const alerts = await this.prisma.alert.groupBy({ by: ['stage'], where: { organisationId }, _count: true });
    const byStage: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};
    for (const c of cases) {
      byStage[c.stage] = (byStage[c.stage] || 0) + 1;
      bySeverity[c.severity] = (bySeverity[c.severity] || 0) + 1;
      const s = c.status?.value || 'Unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
      for (const t of c.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    return {
      cases: { total: cases.length, byStage, bySeverity, byStatus, topTags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10) },
      tasks: tasks.map((t) => ({ status: t.status, count: t._count })),
      observables: observables.map((o) => ({ type: o.dataType, count: o._count })),
      alerts: alerts.map((a) => ({ stage: a.stage, count: a._count })),
    };
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

  private async resolveCaseStatus(organisationId: string, value: string) {
    return this.prisma.caseStatus.findFirst({ where: { organisationId, value } });
  }

  private async resolveUserId(loginOrId: string, organisationId: string) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ id: loginOrId }, { login: loginOrId }], memberships: { some: { organisationId } } },
    });
    return user?.id || null;
  }
}

const CASE_SORT_FIELDS = ['createdAt', 'updatedAt', 'number', 'title', 'severity', 'tlp', 'pap', 'stage', 'startDate', 'endDate', 'dueDate', 'flag'];

/** Builds a Prisma orderBy from "field" / "-field", rejecting unknown fields. */
export function sortClause(raw: any, fallback: string, allowed: string[]) {
  const sort = String(raw || fallback);
  const field = sort.replace(/^[-+]/, '');
  if (!allowed.includes(field)) throw new BadRequestException(`Cannot sort by "${field}". Allowed: ${allowed.join(', ')}`);
  return { [field]: sort.startsWith('-') ? 'desc' : 'asc' } as Record<string, 'asc' | 'desc'>;
}

/** undefined → leave as is, null/'' → clear, value → Date. */
export function optionalDate(value: any) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${value}`);
  return d;
}

export function normaliseTags(tags: any[]): string[] {
  return Array.from(new Set((tags || []).map((t) => String(t).trim()).filter(Boolean)));
}

/** Multipart form fields arrive as strings: accept "true"/"1"/"on". */
function parseBoolean(value: any, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'on', 'yes'].includes(String(value).toLowerCase());
}

function parseTags(value: any): string[] {
  if (Array.isArray(value)) return normaliseTags(value);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return normaliseTags(parsed);
  } catch {
    // fall through to comma-separated list
  }
  return normaliseTags(value.split(','));
}
