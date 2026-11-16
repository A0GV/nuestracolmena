import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/decorators/auth.decorators';
import { AttachmentsService } from '../attachments/attachments.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
  ) {}

  caseStatuses(user: AuthUser) {
    return this.prisma.caseStatus.findMany({ where: { organisationId: user.organisationId }, orderBy: { order: 'asc' } });
  }
  createCaseStatus(user: AuthUser, data: any) {
    return this.prisma.caseStatus.create({ data: { organisationId: user.organisationId, ...data, order: Number(data.order ?? 0) } });
  }
  updateCaseStatus(user: AuthUser, id: string, data: any) {
    return this.prisma.caseStatus.update({ where: { id }, data });
  }
  deleteCaseStatus(user: AuthUser, id: string) {
    return this.prisma.caseStatus.delete({ where: { id } });
  }

  alertStatuses(user: AuthUser) {
    return this.prisma.alertStatus.findMany({ where: { organisationId: user.organisationId }, orderBy: { order: 'asc' } });
  }
  createAlertStatus(user: AuthUser, data: any) {
    return this.prisma.alertStatus.create({ data: { organisationId: user.organisationId, ...data, order: Number(data.order ?? 0) } });
  }
  updateAlertStatus(user: AuthUser, id: string, data: any) {
    return this.prisma.alertStatus.update({ where: { id }, data });
  }
  deleteAlertStatus(user: AuthUser, id: string) {
    return this.prisma.alertStatus.delete({ where: { id } });
  }

  customFields(user: AuthUser) {
    return this.prisma.customField.findMany({ where: { organisationId: user.organisationId }, orderBy: { order: 'asc' } });
  }
  createCustomField(user: AuthUser, data: any) {
    if (!data.name || !data.reference) throw new BadRequestException('name and reference are required');
    return this.prisma.customField.create({ data: { organisationId: user.organisationId, ...data, order: Number(data.order ?? 0) } });
  }
  updateCustomField(user: AuthUser, id: string, data: any) {
    return this.prisma.customField.update({ where: { id }, data });
  }
  deleteCustomField(user: AuthUser, id: string) {
    return this.prisma.customField.delete({ where: { id } });
  }

  tags(user: AuthUser) {
    return this.prisma.tag.findMany({ where: { organisationId: user.organisationId }, orderBy: { name: 'asc' } });
  }
  createTag(user: AuthUser, data: any) {
    if (!data.name) throw new BadRequestException('name is required');
    return this.prisma.tag.create({ data: { organisationId: user.organisationId, name: data.name, colour: data.colour || '#000000' } });
  }
  updateTag(user: AuthUser, id: string, data: any) {
    return this.prisma.tag.update({ where: { id }, data: { name: data.name ?? undefined, colour: data.colour ?? undefined } });
  }
  deleteTag(user: AuthUser, id: string) {
    return this.prisma.tag.delete({ where: { id } });
  }

  async patterns(query: any) {
    const search = query.search !== undefined ? String(query.search).trim() : '';
    const includeRevoked = query.includeRevoked === 'true' || query.includeRevoked === true;

    const conditions: Prisma.Sql[] = [];
    if (!includeRevoked) conditions.push(Prisma.sql`p."revoked" = false`);
    if (query.tactic) {
      const tactic = await this.prisma.tactic.findFirst({
        where: { OR: [{ shortName: String(query.tactic) }, { tacticId: String(query.tactic) }, { name: String(query.tactic) }] },
      });
      const values = Array.from(new Set([String(query.tactic), tactic?.name, tactic?.shortName].filter(Boolean))) as string[];
      if (values.length) {
        conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM unnest(p."tactics") AS tactic WHERE tactic IN (${Prisma.join(values.map((value) => Prisma.sql`${value}`), ', ')}))`);
      }
    }
    let rank: Prisma.Sql | null = null;
    if (search) {
      const contains = `%${search}%`;
      const prefix = `${search}%`;
      conditions.push(Prisma.sql`(p."patternId" ILIKE ${contains} OR p."name" ILIKE ${contains} OR p."description" ILIKE ${contains})`);
      rank = Prisma.sql`CASE
        WHEN p."patternId" ILIKE ${search} THEN 0
        WHEN p."patternId" ILIKE ${prefix} THEN 1
        WHEN p."name" ILIKE ${search} THEN 2
        WHEN p."name" ILIKE ${prefix} THEN 3
        WHEN p."name" ILIKE ${contains} THEN 4
        WHEN p."description" ILIKE ${contains} THEN 5
        ELSE 6
      END`;
    }

    const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    const order = rank
      ? Prisma.sql`ORDER BY ${rank} ASC, p."revoked" ASC, p."patternId" ASC`
      : Prisma.sql`ORDER BY p."revoked" ASC, p."patternId" ASC`;
    const fetchItems = (take: number, skip: number) =>
      this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT p.* FROM "Pattern" p ${where} ${order} LIMIT ${take} OFFSET ${skip}`);

    const paginated = query.limit !== undefined || query.offset !== undefined;
    if (!paginated) {
      // Legacy shape: existing callers expect a plain array.
      return fetchItems(500, 0);
    }
    const limit = Math.max(1, Math.min(5000, Number(query.limit ?? 100)));
    const offset = Math.max(0, Number(query.offset ?? 0));
    const [items, countRows] = await Promise.all([
      fetchItems(limit, offset),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT COUNT(*)::int AS count FROM "Pattern" p ${where}`),
    ]);
    return { items, total: countRows[0]?.count ?? 0, limit, offset };
  }
  createPattern(data: any) {
    return this.prisma.pattern.create({ data });
  }

  templates(user: AuthUser) {
    return this.prisma.caseTemplate.findMany({
      where: { organisationId: user.organisationId },
      include: { tasks: { orderBy: { order: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }
  createTemplate(user: AuthUser, data: any) {
    if (!data.name) throw new BadRequestException('name is required');
    return this.prisma.caseTemplate.create({
      data: {
        organisationId: user.organisationId,
        name: data.name,
        displayName: data.displayName || data.name,
        titlePrefix: data.titlePrefix || null,
        description: data.description || '',
        severity: Number(data.severity ?? 2),
        tlp: Number(data.tlp ?? 2),
        pap: Number(data.pap ?? 2),
        tags: data.tags || [],
        customFields: data.customFields || {},
        taskRule: data.taskRule || 'manual',
        observableRule: data.observableRule || 'manual',
        createdById: user.id,
        tasks: {
          create: (data.tasks || []).map((t: any, i: number) => ({
            title: t.title,
            group: t.group || null,
            description: t.description || '',
            order: i,
            dueDays: t.dueDays ?? null,
            mandatory: !!t.mandatory,
          })),
        },
      },
      include: { tasks: true },
    });
  }
  updateTemplate(user: AuthUser, id: string, data: any) {
    return this.prisma.caseTemplate.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        displayName: data.displayName ?? undefined,
        description: data.description ?? undefined,
        severity: data.severity !== undefined ? Number(data.severity) : undefined,
        tlp: data.tlp !== undefined ? Number(data.tlp) : undefined,
        pap: data.pap !== undefined ? Number(data.pap) : undefined,
        tags: data.tags ?? undefined,
        customFields: data.customFields ?? undefined,
      },
    });
  }
  deleteTemplate(user: AuthUser, id: string) {
    return this.prisma.caseTemplate.delete({ where: { id } });
  }

  dashboards(user: AuthUser) {
    return this.prisma.dashboard.findMany({
      where: { organisationId: user.organisationId },
      include: { widgets: { orderBy: { position: 'asc' } }, createdBy: { select: { id: true, login: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
  createDashboard(user: AuthUser, data: any) {
    return this.prisma.dashboard.create({
      data: {
        organisationId: user.organisationId,
        name: data.name || 'Untitled dashboard',
        description: data.description || '',
        visibility: data.visibility || 'shared',
        createdById: user.id,
        widgets: {
          create: (data.widgets || []).map((w: any, i: number) => ({
            type: w.type,
            title: w.title,
            config: w.config || {},
            position: i,
            size: w.size || 'medium',
          })),
        },
      },
      include: { widgets: true },
    });
  }
  updateDashboard(user: AuthUser, id: string, data: any) {
    return this.prisma.dashboard.update({
      where: { id },
      data: { name: data.name ?? undefined, description: data.description ?? undefined, visibility: data.visibility ?? undefined },
    });
  }
  deleteDashboard(user: AuthUser, id: string) {
    return this.prisma.dashboard.delete({ where: { id } });
  }

  pages(user: AuthUser) {
    return this.prisma.page.findMany({
      where: { organisationId: user.organisationId, caseId: null },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }
  async createPage(user: AuthUser, data: any) {
    const page = await this.prisma.page.create({
      data: { organisationId: user.organisationId, title: data.title || 'Untitled', content: data.content || '', category: data.category || null, createdById: user.id },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'create', objectType: 'page', objectId: page.id, details: { caseId: null, title: page.title }, object: page });
    return page;
  }
  async updatePage(user: AuthUser, id: string, data: any) {
    const existing = await this.prisma.page.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Page not found');
    const page = await this.prisma.page.update({ where: { id }, data: { title: data.title ?? undefined, content: data.content ?? undefined, category: data.category ?? undefined } });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'update', objectType: 'page', objectId: id, details: { caseId: page.caseId, title: page.title } });
    return page;
  }
  async deletePage(user: AuthUser, id: string) {
    const existing = await this.prisma.page.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!existing) throw new NotFoundException('Page not found');
    await this.prisma.page.delete({ where: { id } });
    await this.attachments.removeForOwners([{ objectType: 'page', objectId: id }], user.id);
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'delete', objectType: 'page', objectId: id, details: { caseId: existing.caseId, title: existing.title }, object: existing });
    return { ok: true };
  }

  sweepAttachments() {
    return this.attachments.sweepOrphans();
  }

  private casePageWhere(user: AuthUser, caseId: string) {
    return { organisationId: user.organisationId, caseId };
  }
  async casePages(user: AuthUser, caseId: string) {
    const c = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId } });
    if (!c) throw new NotFoundException('Case not found');
    return this.prisma.page.findMany({
      where: this.casePageWhere(user, caseId),
      include: { createdBy: { select: { id: true, login: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }
  async createCasePage(user: AuthUser, caseId: string, data: any) {
    const c = await this.prisma.case.findFirst({ where: { id: caseId, organisationId: user.organisationId } });
    if (!c) throw new NotFoundException('Case not found');
    const page = await this.prisma.page.create({
      data: {
        organisationId: user.organisationId,
        caseId,
        title: data.title || 'Untitled',
        content: data.content || '',
        category: data.category || null,
        createdById: user.id,
      },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'create', objectType: 'page', objectId: page.id, rootId: caseId, rootType: 'Case', details: { caseId, title: page.title }, object: page });
    return page;
  }
  async updateCasePage(user: AuthUser, caseId: string, pageId: string, data: any) {
    const page = await this.prisma.page.findFirst({ where: { id: pageId, ...this.casePageWhere(user, caseId) } });
    if (!page) throw new NotFoundException('Page not found');
    const updated = await this.prisma.page.update({
      where: { id: pageId },
      data: {
        title: data.title ?? undefined,
        content: data.content ?? undefined,
        category: data.category !== undefined ? data.category : undefined,
      },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'update', objectType: 'page', objectId: pageId, rootId: caseId, rootType: 'Case', details: { caseId, title: updated.title } });
    return updated;
  }
  async deleteCasePage(user: AuthUser, caseId: string, pageId: string) {
    const page = await this.prisma.page.findFirst({ where: { id: pageId, ...this.casePageWhere(user, caseId) } });
    if (!page) throw new NotFoundException('Page not found');
    await this.prisma.page.delete({ where: { id: pageId } });
    await this.attachments.removeForOwners([{ objectType: 'page', objectId: pageId }], user.id);
    await this.audit.log({ organisationId: user.organisationId, actorId: user.id, action: 'delete', objectType: 'page', objectId: pageId, rootId: caseId, rootType: 'Case', details: { caseId, title: page.title }, object: page });
    return { ok: true };
  }

  pageTemplates(user: AuthUser) {
    return this.prisma.pageTemplate.findMany({ where: { organisationId: user.organisationId }, orderBy: { name: 'asc' } });
  }
  createPageTemplate(user: AuthUser, data: any) {
    return this.prisma.pageTemplate.create({ data: { organisationId: user.organisationId, name: data.name, content: data.content || '', category: data.category || null } });
  }

  async auditLogs(user: AuthUser) {
    return this.audit.list(user.organisationId, 200);
  }

  async orgSettings(user: AuthUser) {
    const org = await this.prisma.organisation.findUnique({ where: { id: user.organisationId } });
    return {
      organisation: org,
      members: await this.prisma.organisationUser.count({ where: { organisationId: user.organisationId } }),
      cases: await this.prisma.case.count({ where: { organisationId: user.organisationId } }),
      alerts: await this.prisma.alert.count({ where: { organisationId: user.organisationId } }),
      observables: await this.prisma.observable.count({ where: { organisationId: user.organisationId } }),
    };
  }

  async license() {
    const [users, orgs, cases, alerts] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.organisation.count(),
      this.prisma.case.count(),
      this.prisma.alert.count(),
    ]);
    return {
      edition: 'Community',
      status: 'active',
      validUntil: null,
      quotas: { users: 'unlimited', organisations: 'unlimited', cases: 'unlimited' },
      usage: { users, organisations: orgs, cases, alerts },
    };
  }

  async platformStatus() {
    const [users, orgs, cases, alerts, observables, tasks] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.organisation.count(),
      this.prisma.case.count(),
      this.prisma.alert.count(),
      this.prisma.observable.count(),
      this.prisma.caseTask.count(),
    ]);
    return {
      version: '0.1.0',
      status: 'running',
      database: 'postgresql',
      counts: { users, organisations: orgs, cases, alerts, observables, tasks },
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  // Notifications, endpoints, functions, SLA (basic CRUD)
  notifications(user: AuthUser) {
    return this.prisma.notification.findMany({ where: { organisationId: user.organisationId }, orderBy: { createdAt: 'desc' } });
  }
  createNotification(user: AuthUser, data: any) {
    return this.prisma.notification.create({ data: { organisationId: user.organisationId, name: data.name, enabled: data.enabled ?? true, config: parseJsonObject(data.config), createdById: user.id } });
  }
  endpoints(user: AuthUser) {
    // Cortex/MISP servers are managed in /connectors (their API keys must not be listed here).
    return this.prisma.endpoint.findMany({
      where: { type: { notIn: ['cortex', 'misp'] }, OR: [{ organisationId: user.organisationId }, { organisationId: null }] },
      orderBy: { createdAt: 'desc' },
    });
  }
  createEndpoint(user: AuthUser, data: any) {
    if (['cortex', 'misp'].includes(data.type)) throw new BadRequestException('Use Administración → Cortex & MISP to add Cortex/MISP servers');
    return this.prisma.endpoint.create({ data: { organisationId: user.organisationId, name: data.name, type: data.type || 'http', config: parseJsonObject(data.config), createdById: user.id } });
  }
  jobs(user: AuthUser) {
    return this.prisma.job.findMany({ where: { organisationId: user.organisationId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  alertFeeders(user: AuthUser) {
    return this.prisma.alertFeeder.findMany({ where: { organisationId: user.organisationId }, orderBy: { createdAt: 'desc' } });
  }
  createAlertFeeder(user: AuthUser, data: any) {
    return this.prisma.alertFeeder.create({ data: { organisationId: user.organisationId, name: data.name, enabled: data.enabled ?? true, config: parseJsonObject(data.config), createdById: user.id } });
  }
}

/** Accepts an object or a JSON string coming from a textarea. */
function parseJsonObject(value: any): any {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fallthrough
  }
  throw new BadRequestException('config must be a valid JSON object');
}
