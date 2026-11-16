import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../events/events.module';
import { AuthUser } from '../common/decorators/auth.decorators';

export type SlaObjectType = 'case' | 'alert' | 'task';
export type SlaObjective = 'acknowledge' | 'resolve';
export type SlaState = 'ok' | 'warning' | 'breached' | 'met' | 'met-late';

const OBJECT_TYPES: SlaObjectType[] = ['case', 'alert', 'task'];
const OBJECT_TYPE_NAME: Record<SlaObjectType, string> = { case: 'Case', alert: 'Alert', task: 'Task' };
const RESOLVED_ALERT_STAGES = ['Closed', 'Imported', 'Ignored', 'FalsePositive', 'Duplicate'];
const RESOLVED_TASK_STATUSES = ['Completed', 'Cancel'];

interface NormalisedRule {
  id: string;
  name: string;
  order: number;
  config: any;
}

export interface SlaObjectiveResult {
  dueAt: string;
  metAt?: string;
  state: SlaState;
}

export interface SlaEvaluation {
  ruleId: string;
  ruleName: string;
  acknowledge?: SlaObjectiveResult;
  resolve?: SlaObjectiveResult;
}

/**
 * SLA rules and evaluation.
 *
 * The first enabled rule matching an object wins; rules are ordered by `order`
 * ascending and then by `createdAt` ascending. A rule only applies to its
 * `appliesTo` object type. Case acknowledgement means "assigned and no longer
 * New"; alert acknowledgement means "read or no longer New"; task
 * acknowledgement means "InProgress". Resolution is closing/importing the
 * object. Deadlines start at the object createdAt (alerts use `date` when set).
 */
@Injectable()
export class SlaService {
  private readonly logger = new Logger('Sla');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  // ---------------------------------------------------------------- rules CRUD

  listRules(user: AuthUser) {
    return this.prisma.slaRule.findMany({
      where: { organisationId: user.organisationId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createRule(user: AuthUser, data: any) {
    if (!data?.name?.trim()) throw new BadRequestException('name is required');
    const config = validateSlaConfig(data.config);
    return this.prisma.slaRule.create({
      data: {
        organisationId: user.organisationId,
        name: String(data.name).trim(),
        enabled: data.enabled !== false,
        order: normaliseOrder(data.order, 0),
        config,
      },
    });
  }

  async updateRule(user: AuthUser, id: string, data: any) {
    const existing = await this.getRule(user, id);
    if (data.name !== undefined && !String(data.name).trim()) throw new BadRequestException('name is required');
    const config = data.config !== undefined ? validateSlaConfig(data.config) : undefined;
    return this.prisma.slaRule.update({
      where: { id },
      data: {
        name: data.name !== undefined ? String(data.name).trim() : undefined,
        enabled: data.enabled ?? undefined,
        order: data.order !== undefined ? normaliseOrder(data.order, existing.order) : undefined,
        config,
      },
    });
  }

  async deleteRule(user: AuthUser, id: string) {
    await this.getRule(user, id);
    await this.prisma.slaEvent.deleteMany({ where: { organisationId: user.organisationId, ruleId: id } });
    await this.prisma.slaRule.delete({ where: { id } });
    return { ok: true };
  }

  private async getRule(user: AuthUser, id: string) {
    const rule = await this.prisma.slaRule.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!rule) throw new NotFoundException('SLA rule not found');
    return rule;
  }

  // ---------------------------------------------------------------- evaluation

  async rulesFor(organisationId: string): Promise<NormalisedRule[]> {
    const rules = await this.prisma.slaRule.findMany({
      where: { organisationId, enabled: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    return normaliseRules(rules);
  }

  evaluateWithRules(object: any, type: SlaObjectType, rules: NormalisedRule[], now = new Date()): SlaEvaluation | null {
    if (!object || !OBJECT_TYPES.includes(type)) return null;
    const rule = rules.find((candidate) => ruleMatches(candidate.config, object, type));
    if (!rule) return null;
    return this.buildEvaluation(object, type, rule, now);
  }

  async evaluate(object: any, type: SlaObjectType, rules?: NormalisedRule[]) {
    const list = rules ?? (await this.rulesFor(object.organisationId));
    return this.evaluateWithRules(object, type, list);
  }

  attach(objects: any[], type: SlaObjectType, rules: NormalisedRule[]) {
    return (objects || []).map((object) => ({ ...object, sla: this.evaluateWithRules(object, type, rules) }));
  }

  async attachOne(object: any, type: SlaObjectType, rules?: NormalisedRule[]) {
    if (!object) return object;
    return { ...object, sla: await this.evaluate(object, type, rules) };
  }

  /** Sets the case dueDate from its matching rule when it has no explicit due date. */
  async applyDefaultDueDate(caseObject: any) {
    if (!caseObject || caseObject.dueDate) return { object: caseObject, sla: null };
    const sla = await this.evaluate(caseObject, 'case');
    if (sla?.resolve?.dueAt) {
      const dueDate = new Date(sla.resolve.dueAt);
      await this.prisma.case.update({ where: { id: caseObject.id }, data: { dueDate } });
      return { object: { ...caseObject, dueDate }, sla };
    }
    return { object: caseObject, sla };
  }

  private buildEvaluation(object: any, type: SlaObjectType, rule: NormalisedRule, now: Date): SlaEvaluation {
    const config = rule.config;
    const referenceStart = referenceStartOf(object, type);
    const acknowledgedAt = dateOrNull(object.acknowledgedAt);
    const resolvedAt = resolvedAtOf(object, type);
    const warnPercent = Number(config.warnPercent ?? 80);
    const result: SlaEvaluation = { ruleId: rule.id, ruleName: rule.name };

    const acknowledgeMinutes = numberOrUndefined(config.objectives?.acknowledgeMinutes);
    if (acknowledgeMinutes !== undefined) {
      const dueAt = new Date(referenceStart.getTime() + acknowledgeMinutes * 60000);
      result.acknowledge = objectiveResult(dueAt, acknowledgedAt, acknowledgeMinutes, warnPercent, now);
    }
    const resolveMinutes = numberOrUndefined(config.objectives?.resolveMinutes);
    if (resolveMinutes !== undefined) {
      const dueAt = new Date(referenceStart.getTime() + resolveMinutes * 60000);
      result.resolve = objectiveResult(dueAt, resolvedAt, resolveMinutes, warnPercent, now);
    }
    return result;
  }

  // ---------------------------------------------------------------- preview / summary

  async preview(user: AuthUser, id: string) {
    const stored = await this.getRule(user, id);
    const config = safeConfig(stored.config);
    if (!config) throw new BadRequestException('This SLA rule has an invalid config');
    const rules = await this.rulesFor(user.organisationId);
    const objects = await this.loadObjects(config.appliesTo, { organisationId: user.organisationId }, false);
    const now = new Date();
    const items: any[] = [];
    for (const object of objects) {
      const evaluation = this.evaluateWithRules(object, config.appliesTo, rules, now);
      if (!evaluation || evaluation.ruleId !== stored.id) continue;
      items.push({
        objectType: config.appliesTo,
        objectId: object.id,
        title: object.title,
        number: object.number,
        status: object.stage ?? object.status,
        acknowledge: evaluation.acknowledge,
        resolve: evaluation.resolve,
      });
    }
    return { ruleId: stored.id, ruleName: stored.name, appliesTo: config.appliesTo, count: items.length, items };
  }

  async summary(user: AuthUser, fromRaw?: string, toRaw?: string) {
    const now = new Date();
    const to = parseDate(toRaw) ?? now;
    const from = parseDate(fromRaw) ?? new Date(now.getTime() - 30 * 86400000);
    if (from.getTime() > to.getTime()) throw new BadRequestException('from must be before to');
    const rules = await this.rulesFor(user.organisationId);
    const byType = new Map<SlaObjectType, any[]>();
    for (const type of OBJECT_TYPES) {
      if (!rules.some((rule) => rule.config.appliesTo === type)) continue;
      byType.set(type, await this.loadObjects(type, { organisationId: user.organisationId, createdAt: { gte: from, lte: to } }, true));
    }

    const rows: any[] = [];
    const overall: Record<SlaObjective, any> = { acknowledge: emptyCounts(), resolve: emptyCounts() };
    for (const rule of rules) {
      const type: SlaObjectType = rule.config.appliesTo;
      const row: any = { ruleId: rule.id, ruleName: rule.name, appliesTo: type, objectives: {} };
      for (const objective of ['acknowledge', 'resolve'] as SlaObjective[]) {
        if (numberOrUndefined(rule.config.objectives?.[`${objective}Minutes`]) === undefined) continue;
        const counts = emptyCounts();
        for (const object of byType.get(type) || []) {
          const evaluation = this.evaluateWithRules(object, type, rules);
          if (!evaluation || evaluation.ruleId !== rule.id) continue;
          const value = evaluation[objective];
          if (!value) continue;
          counts.total++;
          if (value.state === 'met') counts.metOnTime++;
          else if (value.state === 'met-late') counts.metLate++;
          else if (value.state === 'breached' && !resolvedAtOf(object, type)) counts.breachedOpen++;
        }
        row.objectives[objective] = withCompliance(counts);
        addCounts(overall[objective], counts);
      }
      rows.push(row);
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      rules: rows,
      overall: { acknowledge: withCompliance(overall.acknowledge), resolve: withCompliance(overall.resolve) },
    };
  }

  // ---------------------------------------------------------------- scheduler

  async runPass(options: { organisationId?: string } = {}) {
    const where: any = { enabled: true };
    if (options.organisationId) where.organisationId = options.organisationId;
    const storedRules = await this.prisma.slaRule.findMany({ where, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
    const rulesByOrg = new Map<string, NormalisedRule[]>();
    for (const rule of storedRules) {
      const list = rulesByOrg.get(rule.organisationId) || [];
      const normalised = normaliseRules([rule]);
      if (normalised.length) list.push(...normalised);
      rulesByOrg.set(rule.organisationId, list);
    }
    if (!rulesByOrg.size) return { emitted: 0 };

    const organisationIds = Array.from(rulesByOrg.keys());
    const emitted: any[] = [];
    for (const type of OBJECT_TYPES) {
      if (!Array.from(rulesByOrg.values()).some((list) => list.some((rule) => rule.config.appliesTo === type))) continue;
      let objects: any[] = [];
      try {
        objects = await this.loadObjects(type, { organisationId: { in: organisationIds } }, false);
      } catch (e: any) {
        this.logger.warn(`Could not load ${type} objects: ${e.message}`);
        continue;
      }
      for (const object of objects) {
        const rules = rulesByOrg.get(object.organisationId);
        if (!rules) continue;
        try {
          const evaluation = this.evaluateWithRules(object, type, rules);
          if (!evaluation) continue;
          const candidates: { objective: SlaObjective; kind: 'warning' | 'breach'; dueAt: string }[] = [];
          for (const objective of ['acknowledge', 'resolve'] as SlaObjective[]) {
            const value = evaluation[objective];
            if (!value || value.metAt) continue;
            if (value.state === 'warning') candidates.push({ objective, kind: 'warning', dueAt: value.dueAt });
            else if (value.state === 'breached') candidates.push({ objective, kind: 'breach', dueAt: value.dueAt });
          }
          for (const candidate of candidates) {
            const created = await this.persistEvent(object.organisationId, evaluation.ruleId, type, object.id, candidate.objective, candidate.kind);
            if (!created) continue;
            const details = {
              sla: {
                kind: candidate.kind,
                objective: candidate.objective,
                dueAt: candidate.dueAt,
                rule: { id: evaluation.ruleId, name: evaluation.ruleName },
              },
            };
            this.events.emit({
              action: candidate.kind === 'warning' ? 'SlaWarning' : 'SlaBreached',
              objectType: OBJECT_TYPE_NAME[type],
              objectId: object.id,
              rootId: type === 'task' ? object.caseId : object.id,
              rootType: type === 'task' ? 'Case' : OBJECT_TYPE_NAME[type],
              organisationId: object.organisationId,
              details,
            });
            emitted.push({ objectType: type, objectId: object.id, ruleId: evaluation.ruleId, ...candidate });
          }
        } catch (e: any) {
          this.logger.warn(`SLA evaluation failed for ${type} ${object.id}: ${e.message}`);
        }
      }
    }
    return { emitted: emitted.length, events: emitted };
  }

  private async persistEvent(organisationId: string, ruleId: string, objectType: SlaObjectType, objectId: string, objective: SlaObjective, kind: string) {
    try {
      await this.prisma.slaEvent.create({
        data: { organisationId, ruleId, objectType: OBJECT_TYPE_NAME[objectType], objectId, objective, kind },
      });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002') return false;
      this.logger.warn(`Could not persist SLA event: ${e.message}`);
      return false;
    }
  }

  async backfillAcknowledgements() {
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "Case" SET "acknowledgedAt" = "updatedAt" WHERE "acknowledgedAt" IS NULL AND "assigneeId" IS NOT NULL AND "stage" NOT IN ('New', 'Closed')`,
      );
      await this.prisma.$executeRawUnsafe(
        `UPDATE "Alert" SET "acknowledgedAt" = "updatedAt" WHERE "acknowledgedAt" IS NULL AND "stage" <> 'Closed' AND ("read" = true OR "stage" <> 'New')`,
      );
      await this.prisma.$executeRawUnsafe(
        `UPDATE "CaseTask" SET "acknowledgedAt" = "updatedAt" WHERE "acknowledgedAt" IS NULL AND "status" = 'InProgress'`,
      );
    } catch (e: any) {
      this.logger.warn(`Acknowledgement backfill failed: ${e.message}`);
    }
  }

  private loadObjects(type: SlaObjectType, where: any, includeResolved: boolean): Promise<any[]> {
    if (type === 'case') {
      const query: any = { ...where };
      if (!includeResolved) {
        query.closedAt = null;
        query.stage = { not: 'Closed' };
      }
      return this.prisma.case.findMany({
        where: query,
        select: {
          id: true, organisationId: true, number: true, title: true, severity: true, tags: true,
          stage: true, assigneeId: true, acknowledgedAt: true, closedAt: true, createdAt: true,
          updatedAt: true, dueDate: true, customFields: true,
        },
      });
    }
    if (type === 'alert') {
      const query: any = { ...where };
      if (!includeResolved) {
        query.caseId = null;
        query.stage = { notIn: RESOLVED_ALERT_STAGES };
      }
      return this.prisma.alert.findMany({
        where: query,
        select: {
          id: true, organisationId: true, type: true, source: true, title: true, severity: true,
          tags: true, stage: true, read: true, caseId: true, date: true, createdAt: true,
          updatedAt: true, acknowledgedAt: true,
        },
      });
    }
    const query: any = { ...where };
    if (!includeResolved) query.status = { notIn: RESOLVED_TASK_STATUSES };
    return this.prisma.caseTask.findMany({
      where: query,
      select: {
        id: true, organisationId: true, caseId: true, title: true, status: true, createdAt: true,
        updatedAt: true, endDate: true, acknowledgedAt: true, startDate: true, order: true,
      },
    });
  }
}

// ------------------------------------------------------------------ helpers

export function validateSlaConfig(raw: any): any {
  const config = parseConfigObject(raw);
  if (!OBJECT_TYPES.includes(config.appliesTo)) {
    throw new BadRequestException('config.appliesTo must be one of: case, alert, task');
  }
  const match = config.match ?? {};
  if (typeof match !== 'object' || Array.isArray(match)) throw new BadRequestException('config.match must be an object');
  const normalisedMatch: any = {};
  if (match.severityIn !== undefined) {
    if (!Array.isArray(match.severityIn) || match.severityIn.some((value: any) => !Number.isFinite(Number(value)))) {
      throw new BadRequestException('config.match.severityIn must be an array of numbers');
    }
    normalisedMatch.severityIn = match.severityIn.map((value: any) => Number(value));
  }
  for (const key of ['tagsAny', 'alertTypeIn', 'sourceIn', 'templateIn']) {
    if (match[key] === undefined) continue;
    if (!Array.isArray(match[key]) || match[key].some((value: any) => typeof value !== 'string')) {
      throw new BadRequestException(`config.match.${key} must be an array of strings`);
    }
    normalisedMatch[key] = match[key].map((value: string) => value.trim()).filter(Boolean);
  }
  const objectives = config.objectives;
  if (!objectives || typeof objectives !== 'object' || Array.isArray(objectives)) {
    throw new BadRequestException('config.objectives must be an object');
  }
  const normalisedObjectives: any = {};
  for (const key of ['acknowledgeMinutes', 'resolveMinutes']) {
    if (objectives[key] === undefined || objectives[key] === null) continue;
    const value = Number(objectives[key]);
    if (!Number.isFinite(value) || value < 0) throw new BadRequestException(`config.objectives.${key} must be a non-negative number`);
    normalisedObjectives[key] = value;
  }
  if (normalisedObjectives.acknowledgeMinutes === undefined && normalisedObjectives.resolveMinutes === undefined) {
    throw new BadRequestException('config.objectives requires acknowledgeMinutes and/or resolveMinutes');
  }
  let warnPercent = 80;
  if (config.warnPercent !== undefined && config.warnPercent !== null) {
    warnPercent = Number(config.warnPercent);
    if (!Number.isFinite(warnPercent) || warnPercent < 0 || warnPercent > 100) {
      throw new BadRequestException('config.warnPercent must be a number between 0 and 100');
    }
  }
  if (config.businessHours !== undefined && config.businessHours !== false) {
    throw new BadRequestException('config.businessHours=true is not supported yet');
  }
  return { appliesTo: config.appliesTo, match: normalisedMatch, objectives: normalisedObjectives, warnPercent, businessHours: false };
}

function parseConfigObject(raw: any) {
  if (raw === undefined || raw === null || raw === '') throw new BadRequestException('config is required');
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BadRequestException('config must be a valid JSON object');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('config must be an object');
  return value;
}

function safeConfig(raw: any) {
  try {
    return validateSlaConfig(raw);
  } catch {
    return null;
  }
}

function normaliseRules(rules: any[]): NormalisedRule[] {
  const out: NormalisedRule[] = [];
  for (const rule of rules) {
    const config = safeConfig(rule.config);
    if (!config) continue;
    out.push({ id: rule.id, name: rule.name, order: rule.order ?? 0, config });
  }
  return out;
}

function ruleMatches(config: any, object: any, type: SlaObjectType): boolean {
  if (config.appliesTo !== type) return false;
  const match = config.match || {};
  if (Array.isArray(match.severityIn) && match.severityIn.length && !match.severityIn.includes(Number(object.severity))) return false;
  if (Array.isArray(match.tagsAny) && match.tagsAny.length) {
    const tags = new Set((object.tags || []).map((tag: string) => String(tag).toLowerCase()));
    if (!match.tagsAny.some((tag: string) => tags.has(String(tag).toLowerCase()))) return false;
  }
  if (Array.isArray(match.alertTypeIn) && match.alertTypeIn.length) {
    if (type !== 'alert' || !match.alertTypeIn.includes(object.type)) return false;
  }
  if (Array.isArray(match.sourceIn) && match.sourceIn.length) {
    if (type !== 'alert' || !match.sourceIn.includes(object.source)) return false;
  }
  if (Array.isArray(match.templateIn) && match.templateIn.length) {
    const template = object.caseTemplate || object.template || object.templateName;
    if (!template || !match.templateIn.includes(template)) return false;
  }
  return true;
}

function referenceStartOf(object: any, type: SlaObjectType): Date {
  if (type === 'alert' && object.date) return new Date(object.date);
  return new Date(object.createdAt || object.startDate || Date.now());
}

function resolvedAtOf(object: any, type: SlaObjectType): Date | null {
  if (type === 'case') {
    if (object.closedAt) return new Date(object.closedAt);
    return object.stage === 'Closed' ? new Date(object.updatedAt) : null;
  }
  if (type === 'alert') {
    if (object.caseId || RESOLVED_ALERT_STAGES.includes(object.stage)) return new Date(object.updatedAt || Date.now());
    return null;
  }
  if (RESOLVED_TASK_STATUSES.includes(object.status)) return new Date(object.endDate || object.updatedAt || Date.now());
  return null;
}

function objectiveResult(dueAt: Date, metAt: Date | null, durationMinutes: number, warnPercent: number, now: Date): SlaObjectiveResult {
  if (metAt) {
    return {
      dueAt: dueAt.toISOString(),
      metAt: metAt.toISOString(),
      state: metAt.getTime() <= dueAt.getTime() ? 'met' : 'met-late',
    };
  }
  if (now.getTime() >= dueAt.getTime()) return { dueAt: dueAt.toISOString(), state: 'breached' };
  const warningStart = dueAt.getTime() - durationMinutes * 60000 * Math.max(0, 100 - warnPercent) / 100;
  if (now.getTime() >= warningStart) return { dueAt: dueAt.toISOString(), state: 'warning' };
  return { dueAt: dueAt.toISOString(), state: 'ok' };
}

function dateOrNull(value: any): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberOrUndefined(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseDate(value: any): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`Invalid date: ${value}`);
  return date;
}

function normaliseOrder(value: any, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BadRequestException('order must be a number');
  return Math.trunc(number);
}

function emptyCounts() {
  return { total: 0, metOnTime: 0, metLate: 0, breachedOpen: 0 };
}

function addCounts(target: any, source: any) {
  target.total += source.total;
  target.metOnTime += source.metOnTime;
  target.metLate += source.metLate;
  target.breachedOpen += source.breachedOpen;
}

function withCompliance(counts: any) {
  const denominator = counts.metOnTime + counts.metLate + counts.breachedOpen;
  const compliance = denominator ? Math.round((counts.metOnTime / denominator) * 1000) / 10 : 100;
  return { ...counts, compliance };
}
