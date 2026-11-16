import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { mapAction, mapModelList, toTheHive4List } from '../compat/thehive-mapper';
import { CorrelationService } from '../correlation/correlation.service';
import { attachPatterns } from '../mitre/pattern-helpers';

type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'array' | 'json';

interface FieldDesc {
  kind: 'scalar' | 'relation' | 'array' | 'json';
  field?: string;
  relation?: string;
  type: FieldType;
}

interface Starter {
  model: string;
  orgScoped: boolean;
  kind: 'list' | 'get';
  fields: Record<string, FieldDesc>;
  defaultOrder?: any;
  /** Organisation pages and the legacy listPage starter hide case-scoped pages. */
  excludeCasePages?: boolean;
}

const scalar = (field: string, type: FieldType = 'string'): FieldDesc => ({ kind: 'scalar', field, type });
const relation = (rel: string, field: string, type: FieldType = 'string'): FieldDesc => ({ kind: 'relation', relation: rel, field, type });
const arrayField = (field: string): FieldDesc => ({ kind: 'array', field, type: 'array' });
const jsonField = (field: string): FieldDesc => ({ kind: 'json', field, type: 'json' });

const common = {
  _id: scalar('id'),
  id: scalar('id'),
  _createdAt: scalar('createdAt', 'date'),
  _updatedAt: scalar('updatedAt', 'date'),
  createdAt: scalar('createdAt', 'date'),
  updatedAt: scalar('updatedAt', 'date'),
};

const caseFields: Record<string, FieldDesc> = {
  ...common,
  title: scalar('title'),
  description: scalar('description'),
  summary: scalar('summary'),
  stage: scalar('stage'),
  number: scalar('number', 'number'),
  severity: scalar('severity', 'number'),
  tlp: scalar('tlp', 'number'),
  pap: scalar('pap', 'number'),
  flag: scalar('flag', 'boolean'),
  status: relation('status', 'value'),
  assignee: relation('assignee', 'login'),
  tags: arrayField('tags'),
  startDate: scalar('startDate', 'date'),
  endDate: scalar('endDate', 'date'),
  dueDate: scalar('dueDate', 'date'),
  closedAt: scalar('closedAt', 'date'),
  caseTemplate: jsonField('caseTemplate'),
  customFields: jsonField('customFields'),
};

const alertFields: Record<string, FieldDesc> = {
  ...common,
  title: scalar('title'),
  description: scalar('description'),
  summary: scalar('summary'),
  stage: scalar('stage'),
  type: scalar('type'),
  source: scalar('source'),
  sourceRef: scalar('sourceRef'),
  externalLink: scalar('externalLink'),
  severity: scalar('severity', 'number'),
  tlp: scalar('tlp', 'number'),
  pap: scalar('pap', 'number'),
  flag: scalar('flag', 'boolean'),
  follow: scalar('follow', 'boolean'),
  read: scalar('read', 'boolean'),
  status: relation('status', 'value'),
  assignee: relation('assignee', 'login'),
  tags: arrayField('tags'),
  date: scalar('date', 'date'),
  caseId: scalar('caseId'),
  customFields: jsonField('customFields'),
};

const taskFields: Record<string, FieldDesc> = {
  ...common,
  title: scalar('title'),
  description: scalar('description'),
  group: scalar('group'),
  status: scalar('status'),
  flag: scalar('flag', 'boolean'),
  mandatory: scalar('mandatory', 'boolean'),
  order: scalar('order', 'number'),
  assignee: relation('assignee', 'login'),
  caseId: scalar('caseId'),
  startDate: scalar('startDate', 'date'),
  endDate: scalar('endDate', 'date'),
  dueDate: scalar('dueDate', 'date'),
};

const observableFields: Record<string, FieldDesc> = {
  ...common,
  dataType: scalar('dataType'),
  data: scalar('data'),
  message: scalar('message'),
  tlp: scalar('tlp', 'number'),
  pap: scalar('pap', 'number'),
  ioc: scalar('ioc', 'boolean'),
  sighted: scalar('sighted', 'boolean'),
  sightedAt: scalar('sightedAt', 'date'),
  ignoreSimilarity: scalar('ignoreSimilarity', 'boolean'),
  tags: arrayField('tags'),
  startDate: scalar('startDate', 'date'),
  caseId: scalar('caseId'),
  alertId: scalar('alertId'),
};

const logFields: Record<string, FieldDesc> = {
  ...common,
  message: scalar('message'),
  date: scalar('date', 'date'),
  startDate: scalar('date', 'date'),
  includeInTimeline: scalar('includeInTimeline', 'boolean'),
  taskId: scalar('taskId'),
  caseId: scalar('caseId'),
  createdBy: relation('createdBy', 'login'),
};

const commentFields: Record<string, FieldDesc> = {
  ...common,
  message: scalar('message'),
  objectType: scalar('objectType'),
  objectId: scalar('objectId'),
  createdBy: relation('createdBy', 'login'),
};

const procedureFields: Record<string, FieldDesc> = {
  ...common,
  patternId: scalar('patternId'),
  patternName: scalar('patternName'),
  tactic: scalar('tactic'),
  occurDate: scalar('occurDate', 'date'),
  startDate: scalar('occurDate', 'date'),
  description: scalar('description'),
  caseId: scalar('caseId'),
  alertId: scalar('alertId'),
};

const pageFields: Record<string, FieldDesc> = {
  ...common,
  title: scalar('title'),
  name: scalar('title'),
  content: scalar('content'),
  category: scalar('category'),
  caseId: scalar('caseId'),
  createdBy: relation('createdBy', 'login'),
};

const statusFields: Record<string, FieldDesc> = {
  ...common,
  value: scalar('value'),
  stage: scalar('stage'),
  order: scalar('order', 'number'),
  colour: scalar('colour'),
  hidden: scalar('hidden', 'boolean'),
};

const customFieldFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('name'),
  reference: scalar('reference'),
  type: scalar('type'),
  mandatory: scalar('mandatory', 'boolean'),
  order: scalar('order', 'number'),
};

const caseTemplateFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('name'),
  displayName: scalar('displayName'),
  description: scalar('description'),
  severity: scalar('severity', 'number'),
  tlp: scalar('tlp', 'number'),
  pap: scalar('pap', 'number'),
  tags: arrayField('tags'),
};

const tagFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('name'),
  colour: scalar('colour'),
};

const patternFields: Record<string, FieldDesc> = {
  ...common,
  patternId: scalar('patternId'),
  name: scalar('name'),
  description: scalar('description'),
  tactics: arrayField('tactics'),
  platforms: arrayField('platforms'),
  url: scalar('url'),
  revoked: scalar('revoked', 'boolean'),
  isSubtechnique: scalar('isSubtechnique', 'boolean'),
  parentPatternId: scalar('parentPatternId'),
  version: scalar('version'),
  catalog: scalar('catalog'),
  dataSources: arrayField('dataSources'),
};

const organisationFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('name'),
  description: scalar('description'),
};

const profileFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('name'),
  type: scalar('type'),
};

const userFields: Record<string, FieldDesc> = {
  ...common,
  login: scalar('login'),
  name: scalar('name'),
  email: scalar('email'),
  type: scalar('type'),
  locked: scalar('locked', 'boolean'),
};

const dashboardFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('name'),
  description: scalar('description'),
  visibility: scalar('visibility'),
};

const auditFields: Record<string, FieldDesc> = {
  ...common,
  action: scalar('action'),
  objectType: scalar('objectType'),
  objectId: scalar('objectId'),
};

const attachmentFields: Record<string, FieldDesc> = {
  ...common,
  name: scalar('filename'),
  filename: scalar('filename'),
  contentType: scalar('contentType'),
  size: scalar('size', 'number'),
  objectType: scalar('objectType'),
  objectId: scalar('objectId'),
};

const STARTERS: Record<string, Starter> = {
  listCase: { model: 'case', orgScoped: true, kind: 'list', fields: caseFields },
  listAlert: { model: 'alert', orgScoped: true, kind: 'list', fields: alertFields },
  listTask: { model: 'caseTask', orgScoped: true, kind: 'list', fields: taskFields },
  listObservable: { model: 'observable', orgScoped: true, kind: 'list', fields: observableFields },
  listProcedure: { model: 'procedure', orgScoped: true, kind: 'list', fields: procedureFields },
  listComment: { model: 'comment', orgScoped: true, kind: 'list', fields: commentFields },
  listLog: { model: 'taskLog', orgScoped: true, kind: 'list', fields: logFields },
  listPattern: { model: 'pattern', orgScoped: false, kind: 'list', fields: patternFields },
  listOrganisation: { model: 'organisation', orgScoped: false, kind: 'list', fields: organisationFields },
  listProfile: { model: 'profile', orgScoped: false, kind: 'list', fields: profileFields },
  listUser: { model: 'user', orgScoped: false, kind: 'list', fields: userFields },
  listCaseStatus: { model: 'caseStatus', orgScoped: true, kind: 'list', fields: statusFields },
  listAlertStatus: { model: 'alertStatus', orgScoped: true, kind: 'list', fields: statusFields },
  listTag: { model: 'tag', orgScoped: true, kind: 'list', fields: tagFields },
  listCustomField: { model: 'customField', orgScoped: true, kind: 'list', fields: customFieldFields },
  listCaseTemplate: { model: 'caseTemplate', orgScoped: true, kind: 'list', fields: caseTemplateFields },
  listDashboard: { model: 'dashboard', orgScoped: true, kind: 'list', fields: dashboardFields },
  listPage: { model: 'page', orgScoped: true, kind: 'list', fields: pageFields, excludeCasePages: true },
  listOrganisationPage: { model: 'page', orgScoped: true, kind: 'list', fields: pageFields, excludeCasePages: true },
  listAudit: { model: 'auditLog', orgScoped: true, kind: 'list', fields: auditFields },

  getAlert: { model: 'alert', orgScoped: true, kind: 'get', fields: alertFields },
  getCase: { model: 'case', orgScoped: true, kind: 'get', fields: caseFields },
  getTask: { model: 'caseTask', orgScoped: true, kind: 'get', fields: taskFields },
  getObservable: { model: 'observable', orgScoped: true, kind: 'get', fields: observableFields },
  getLog: { model: 'taskLog', orgScoped: true, kind: 'get', fields: logFields },
  getComment: { model: 'comment', orgScoped: true, kind: 'get', fields: commentFields },
  getPage: { model: 'page', orgScoped: true, kind: 'get', fields: pageFields },
};

const DEFAULT_ORDER: Record<string, any> = {
  case: { createdAt: 'desc' },
  alert: { date: 'desc' },
  caseTask: { order: 'asc' },
  observable: { createdAt: 'desc' },
  procedure: { occurDate: 'desc' },
  comment: { createdAt: 'desc' },
  taskLog: { date: 'asc' },
  page: { updatedAt: 'desc' },
  auditLog: { createdAt: 'desc' },
};

const OBSERVABLE_TYPES = [
  'ip',
  'domain',
  'fqdn',
  'url',
  'mail',
  'mail-subject',
  'hash',
  'filename',
  'user-agent',
  'registry',
  'regexp',
  'autonomous-system',
  'other',
].map((name) => ({ name, isAttachment: name === 'filename' }));

const TRAVERSALS = new Set([
  'observables', 'tasks', 'logs', 'comments', 'pages', 'procedures', 'alerts', 'case',
  'attachments', 'similarAlerts', 'similarCases',
]);

@Injectable()
export class QueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly correlation: CorrelationService,
  ) {}

  async execute(user: AuthUser, body: any) {
    const query: any[] = body?.query;
    if (!Array.isArray(query) || query.length === 0) throw new BadRequestException('query array is required');
    const first = query[0];
    const name = first?._name;
    if (name === 'listAction') return this.executeActions(user, query);
    if (name === 'listObservableType') return this.observableTypes(query);

    const starter = STARTERS[name];
    if (!starter) throw new BadRequestException(`Unsupported operation: ${name}`);

    let model = starter.model;
    let fields = starter.fields;
    let where: any = starter.orgScoped ? { organisationId: user.organisationId } : {};
    if (starter.excludeCasePages) where = { AND: [where, { caseId: null }] };

    if (starter.kind === 'get' && first.idOrName !== undefined) {
      const idWhere = await this.idWhere(user, model, first.idOrName);
      where = { AND: [where, idWhere] };
    }

    let orderBy = DEFAULT_ORDER[model] || { createdAt: 'desc' };
    let skip = 0;
    let take = 1000;
    let countOnly = false;
    let counters: Map<string, any> | null = null;

    for (const step of query.slice(1)) {
      if (!step || typeof step !== 'object') continue;
      switch (step._name) {
        case 'filter':
          where = { AND: [where, this.buildFilter(step, fields)] };
          break;
        case 'sort':
          orderBy = this.buildSort(step, fields);
          break;
        case 'page':
          skip = Math.max(0, Number(step.from ?? 0));
          take = Math.min(1000, Math.max(0, Number(step.to ?? skip + 1000) - skip));
          break;
        case 'count':
          countOnly = true;
          break;
        case 'output':
          break;
        default:
          if (TRAVERSALS.has(step._name)) {
            const traversed: any = await this.traverse(user, model, where, step._name);
            if (traversed === null) {
              return countOnly ? 0 : [];
            }
            model = traversed.model;
            fields = traversed.fields;
            where = traversed.where;
            orderBy = traversed.orderBy;
            counters = traversed.counters || null;
            skip = 0;
            take = 1000;
          }
          break;
      }
    }

    const delegate = (this.prisma as any)[model];
    if (!delegate) throw new BadRequestException(`Unsupported collection: ${model}`);

    if (countOnly) return delegate.count({ where });

    const rows = await delegate.findMany({
      where,
      orderBy,
      skip,
      take,
      include: this.includeFor(model),
    });
    const enriched = await this.enrich(user, model, rows);
    const decorated = counters
      ? enriched.map((row: any) => (counters.has(row.id) ? { ...row, ...counters.get(row.id) } : row))
      : enriched;
    const mapped = mapModelList(model, decorated);
    return this.project(mapped, body);
  }

  async executeLegacy(user: AuthUser, starterName: string, body: any) {
    const starter = STARTERS[starterName];
    if (!starter) throw new BadRequestException(`Unsupported operation: ${starterName}`);

    const model = starter.model;
    const fields = starter.fields;
    const baseWhere: any = starter.orgScoped ? { organisationId: user.organisationId } : {};
    const filter = await this.buildLegacyFilter(user, body?.query ?? {}, fields, model, 0);
    const where = Object.keys(filter || {}).length ? { AND: [baseWhere, filter] } : baseWhere;
    const orderBy = this.buildLegacySort(body?.sort, fields, model);
    const { skip, take } = this.legacyRange(body?.range);

    const delegate = (this.prisma as any)[model];
    if (!delegate) throw new BadRequestException(`Unsupported collection: ${model}`);

    const rows = await delegate.findMany({
      where,
      orderBy,
      skip,
      take,
      include: this.includeFor(model),
    });
    const enriched = await this.enrich(user, model, rows);
    return toTheHive4List(model, enriched);
  }

  describe() {
    const models: Record<string, any> = {};
    for (const [op, starter] of Object.entries(STARTERS)) {
      models[starter.model] = {
        initialQuery: op,
        attributes: Object.keys(starter.fields).map((field) => ({ name: field, type: starter.fields[field].type })),
      };
    }
    return models;
  }

  // ---------------------------------------------------------------- actions / types

  private async executeActions(user: AuthUser, query: any[]) {
    const fields: Record<string, FieldDesc> = {
      ...common,
      status: scalar('status'),
      cortexId: jsonField('payload.connectorId'),
      objectId: jsonField('payload.objectId'),
      objectType: jsonField('payload.objectType'),
      responderId: jsonField('payload.responderId'),
      responderName: jsonField('payload.responderName'),
      startDate: scalar('startedAt', 'date'),
      endDate: scalar('finishedAt', 'date'),
    };
    let where: any = { organisationId: user.organisationId, type: 'cortex-responder' };
    let orderBy: any = { createdAt: 'desc' };
    let skip = 0;
    let take = 50;
    let countOnly = false;
    for (const step of query.slice(1)) {
      if (!step || typeof step !== 'object') continue;
      if (step._name === 'filter') where = { AND: [where, this.buildFilter(step, fields)] };
      else if (step._name === 'sort') orderBy = this.buildSort(step, fields);
      else if (step._name === 'page') {
        skip = Math.max(0, Number(step.from ?? 0));
        take = Math.min(1000, Math.max(0, Number(step.to ?? skip + 50) - skip));
      } else if (step._name === 'count') countOnly = true;
    }
    if (countOnly) return this.prisma.job.count({ where });
    const rows = await this.prisma.job.findMany({ where, orderBy, skip, take });
    const mapped = rows.map(mapAction);
    // TheHive action polling (n8n) expects a single object with a `status` field.
    return mapped[0] ?? null;
  }

  private observableTypes(query: any[]) {
    const countOnly = query.some((step) => step?._name === 'count');
    if (countOnly) return OBSERVABLE_TYPES.length;
    return OBSERVABLE_TYPES.map((type) => ({ ...type, _id: type.name, _type: 'ObservableType' }));
  }

  // ---------------------------------------------------------------- starter lookup

  private async idWhere(user: AuthUser, model: string, idOrName: any) {
    const value = String(idOrName);
    const where: any = { organisationId: user.organisationId };
    if (model === 'case' && /^\d+$/.test(value.replace(/^#/, ''))) where.number = Number(value.replace(/^#/, ''));
    else where.id = value;
    const found = await (this.prisma as any)[model].findFirst({ where, select: { id: true } });
    if (!found) throw new NotFoundException(`${model} not found`);
    return where;
  }

  // ---------------------------------------------------------------- traversal

  private async traverse(user: AuthUser, model: string, where: any, relation: string) {
    const current = await (this.prisma as any)[model].findFirst({ where });
    if (!current) return null;
    const organisationId = user.organisationId;

    if (relation === 'observables') {
      if (model === 'case') return { model: 'observable', fields: observableFields, where: { organisationId, caseId: current.id }, orderBy: { createdAt: 'desc' } };
      if (model === 'alert') return { model: 'observable', fields: observableFields, where: { organisationId, alertId: current.id }, orderBy: { createdAt: 'desc' } };
    }
    if (relation === 'tasks' && model === 'case') {
      return { model: 'caseTask', fields: taskFields, where: { organisationId, caseId: current.id }, orderBy: { order: 'asc' } };
    }
    if (relation === 'logs') {
      if (model === 'case') return { model: 'taskLog', fields: logFields, where: { organisationId, caseId: current.id }, orderBy: { date: 'asc' } };
      if (model === 'caseTask') return { model: 'taskLog', fields: logFields, where: { organisationId, taskId: current.id }, orderBy: { date: 'asc' } };
    }
    if (relation === 'comments') {
      if (model === 'case') return { model: 'comment', fields: commentFields, where: { organisationId, objectType: 'case', objectId: current.id }, orderBy: { createdAt: 'desc' } };
      if (model === 'alert') return { model: 'comment', fields: commentFields, where: { organisationId, objectType: 'alert', objectId: current.id }, orderBy: { createdAt: 'desc' } };
    }
    if (relation === 'procedures') {
      if (model === 'case') return { model: 'procedure', fields: procedureFields, where: { organisationId, caseId: current.id }, orderBy: { occurDate: 'desc' } };
      if (model === 'alert') return { model: 'procedure', fields: procedureFields, where: { organisationId, alertId: current.id }, orderBy: { occurDate: 'desc' } };
    }
    if (relation === 'alerts' && model === 'case') {
      return { model: 'alert', fields: alertFields, where: { organisationId, caseId: current.id }, orderBy: { date: 'desc' } };
    }
    if (relation === 'case' && model === 'alert') {
      if (!current.caseId) return null;
      return { model: 'case', fields: caseFields, where: { organisationId, id: current.caseId }, orderBy: { createdAt: 'desc' } };
    }
    if (relation === 'pages' && model === 'case') {
      return { model: 'page', fields: pageFields, where: { organisationId, caseId: current.id }, orderBy: { updatedAt: 'desc' } };
    }
    if (relation === 'attachments') {
      if (model === 'case') return { model: 'attachment', fields: attachmentFields, where: { organisationId, objectType: 'case', objectId: current.id }, orderBy: { createdAt: 'desc' } };
      if (model === 'taskLog') return { model: 'attachment', fields: attachmentFields, where: { organisationId, objectType: 'log', objectId: current.id }, orderBy: { createdAt: 'desc' } };
    }
    if (relation === 'similarAlerts') {
      const { ids, counters } = await this.correlation.similarAlertsForQuery(user, model, current.id);
      return { model: 'alert', fields: alertFields, where: { organisationId, id: { in: ids } }, orderBy: { date: 'desc' }, counters };
    }
    if (relation === 'similarCases') {
      const { ids, counters } = await this.correlation.similarCasesForQuery(user, model, current.id);
      return { model: 'case', fields: caseFields, where: { organisationId, id: { in: ids } }, orderBy: { createdAt: 'desc' }, counters };
    }
    return null;
  }

  // ---------------------------------------------------------------- legacy filters / sort

  private legacyRange(range: any) {
    if (range === undefined || range === null || range === '' || range === 'all') {
      return { skip: 0, take: 1000 };
    }
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(String(range));
    if (!match) return { skip: 0, take: 100 };
    const from = Math.max(0, Number(match[1]));
    const to = Math.max(from, Number(match[2]));
    return { skip: from, take: Math.min(1000, to - from) };
  }

  private buildLegacySort(raw: any, fields: Record<string, FieldDesc>, model: string): any {
    let parts: any[] = [];
    if (Array.isArray(raw)) {
      parts = raw;
    } else if (typeof raw === 'string') {
      const text = raw.trim();
      if (text.startsWith('[')) {
        try {
          parts = JSON.parse(text);
        } catch {
          parts = text.split(',');
        }
      } else {
        parts = text.split(',');
      }
    } else if (raw && typeof raw === 'object') {
      parts = Object.entries(raw).map(([field, direction]) => `${direction === 'desc' ? '-' : '+'}${field}`);
    }
    if (!parts.length) parts = ['-createdAt'];
    const entries = parts
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => {
        const text = String(part).trim();
        const direction = text.startsWith('-') ? 'desc' : 'asc';
        const field = this.legacyFieldName(model, text.replace(/^[-+]/, ''));
        return { [field]: direction };
      });
    return this.buildSort({ _fields: entries }, fields);
  }

  private legacyFieldName(model: string, field: string): string {
    if (model === 'case' && field === 'caseId') return 'number';
    return field;
  }

  private async buildLegacyFilter(user: AuthUser, filter: any, fields: Record<string, FieldDesc>, model: string, depth: number): Promise<any> {
    if (depth > 6) return {};
    if (!filter || typeof filter !== 'object') return {};
    if (Array.isArray(filter)) {
      return { AND: await Promise.all(filter.map((item) => this.buildLegacyFilter(user, item, fields, model, depth + 1))) };
    }
    if ('_and' in filter) {
      const items = this.asList(filter._and);
      return { AND: await Promise.all(items.map((item) => this.buildLegacyFilter(user, item, fields, model, depth + 1))) };
    }
    if ('_or' in filter) {
      const items = this.asList(filter._or);
      return { OR: await Promise.all(items.map((item) => this.buildLegacyFilter(user, item, fields, model, depth + 1))) };
    }
    if ('_not' in filter) {
      return { NOT: await this.buildLegacyFilter(user, filter._not, fields, model, depth + 1) };
    }
    if ('_parent' in filter) {
      return this.buildLegacyParent(user, filter._parent, model, depth + 1);
    }
    if ('_child' in filter) {
      return this.buildLegacyChild(user, filter._child, model, depth + 1);
    }
    if ('_string' in filter) {
      return this.buildLegacyString(filter._string, model);
    }
    if ('_contains' in filter) {
      return this.buildLegacyContains(filter._contains, fields);
    }
    if ('_id' in filter && filter._field === undefined) {
      return { id: filter._id };
    }
    if (filter._field !== undefined) {
      return this.buildOperator('_eq', { _field: this.legacyFieldName(model, filter._field), _value: filter._value }, fields);
    }
    if ('_wildcard' in filter) {
      const spec = filter._wildcard;
      if (!spec || typeof spec !== 'object') return {};
      const value = spec._value;
      if (value === '*' && spec._field === undefined) return {};
      if (value === '*' && spec._field !== undefined) return {};
      return this.buildOperator('_like', { _field: this.legacyFieldName(model, spec._field), _value: value }, fields);
    }
    if ('_like' in filter) {
      const spec = filter._like;
      if (!spec || typeof spec !== 'object') return {};
      return this.buildOperator('_like', { _field: this.legacyFieldName(model, spec._field), _value: spec._value }, fields);
    }
    if ('_between' in filter) {
      const spec = filter._between;
      if (!spec || typeof spec !== 'object') return {};
      return this.buildOperator(
        '_between',
        { _field: this.legacyFieldName(model, spec._field), _from: spec._from, _to: spec._to },
        fields,
      );
    }
    if ('_in' in filter) {
      const spec = filter._in;
      if (!spec || typeof spec !== 'object') return {};
      return this.buildOperator(
        '_in',
        { _field: this.legacyFieldName(model, spec._field), _values: spec._values },
        fields,
      );
    }
    for (const op of ['_gt', '_gte', '_lt', '_lte', '_ne']) {
      if (op in filter) return this.buildLegacyComparison(op, filter[op], fields, model);
    }
    return {};
  }

  private buildLegacyComparison(op: string, spec: any, fields: Record<string, FieldDesc>, model: string): any {
    if (!spec || typeof spec !== 'object') return {};
    if (spec._field !== undefined) {
      return this.buildOperator(op, { _field: this.legacyFieldName(model, spec._field), _value: spec._value }, fields);
    }
    const entries = Object.entries(spec);
    if (!entries.length) return {};
    if (entries.length === 1) {
      const [field, value] = entries[0];
      return this.buildOperator(op, { _field: this.legacyFieldName(model, field), _value: value }, fields);
    }
    return {
      AND: entries.map(([field, value]) =>
        this.buildOperator(op, { _field: this.legacyFieldName(model, field), _value: value }, fields),
      ),
    };
  }

  private buildLegacyString(text: any, model: string): any {
    const value = String(text ?? '');
    if (!value) return {};
    const names =
      model === 'observable'
        ? ['data', 'message']
        : model === 'taskLog'
          ? ['message']
          : model === 'caseTask'
            ? ['title', 'description']
            : ['title', 'description'];
    return { OR: names.map((field) => ({ [field]: { contains: value, mode: 'insensitive' } })) };
  }

  private buildLegacyContains(spec: any, fields: Record<string, FieldDesc>): any {
    const fieldName = typeof spec === 'string' ? spec : spec?._field;
    if (!fieldName) return {};
    const desc = fields[fieldName];
    if (!desc) return {};
    if (desc.kind === 'json') return {};
    if (desc.kind === 'array') return { NOT: { [desc.field]: { equals: [] } } };
    const condition = { not: null };
    if (desc.kind === 'relation') return { [desc.relation]: { [desc.field]: condition } };
    return { AND: [{ [desc.field]: condition }, { [desc.field]: { not: '' } }] };
  }

  private async buildLegacyParent(user: AuthUser, spec: any, childModel: string, depth: number): Promise<any> {
    const parent = this.legacyStarter(spec?._type);
    if (!parent) return {};
    const parentFilter = await this.buildLegacyFilter(user, spec?._query ?? {}, parent.fields, parent.model, depth);
    const parentWhere = parent.orgScoped
      ? { AND: [{ organisationId: user.organisationId }, parentFilter] }
      : parentFilter;
    const rows = await (this.prisma as any)[parent.model].findMany({ where: parentWhere, select: { id: true } });
    const ids = rows.map((row: any) => row.id);
    const key = this.legacyParentKey(childModel, parent.model);
    if (!key) return { id: { in: [] } };
    return { [key]: { in: ids } };
  }

  private async buildLegacyChild(user: AuthUser, spec: any, parentModel: string, depth: number): Promise<any> {
    const child = this.legacyStarter(spec?._type);
    if (!child) return {};
    const childFilter = await this.buildLegacyFilter(user, spec?._query ?? {}, child.fields, child.model, depth);
    const childWhere = child.orgScoped
      ? { AND: [{ organisationId: user.organisationId }, childFilter] }
      : childFilter;
    const key = this.legacyParentKey(child.model, parentModel);
    const select = key ? { [key]: true } : { id: true };
    const rows = await (this.prisma as any)[child.model].findMany({ where: childWhere, select });
    const ids = Array.from(new Set(rows.map((row: any) => row[key]).filter(Boolean)));
    return { id: { in: ids } };
  }

  private legacyStarter(type: string) {
    const names: Record<string, string> = {
      alert: 'listAlert',
      case: 'listCase',
      case_task: 'listTask',
      case_task_log: 'listLog',
      case_artifact: 'listObservable',
      observable: 'listObservable',
      caseTemplate: 'listCaseTemplate',
      user: 'listUser',
    };
    return STARTERS[names[type]];
  }

  private legacyParentKey(childModel: string, parentModel: string): string | null {
    if (childModel === 'observable' && parentModel === 'case') return 'caseId';
    if (childModel === 'observable' && parentModel === 'alert') return 'alertId';
    if (childModel === 'caseTask' && parentModel === 'case') return 'caseId';
    if (childModel === 'taskLog' && parentModel === 'case') return 'caseId';
    if (childModel === 'taskLog' && parentModel === 'caseTask') return 'taskId';
    return null;
  }

  // ---------------------------------------------------------------- filters / sort

  private buildFilter(filter: any, fields: Record<string, FieldDesc>): any {
    if (!filter || typeof filter !== 'object') return {};
    if (Array.isArray(filter)) return { AND: filter.map((item) => this.buildFilter(item, fields)) };
    if ('_and' in filter) return { AND: this.asList(filter._and).map((item) => this.buildFilter(item, fields)) };
    if ('_or' in filter) return { OR: this.asList(filter._or).map((item) => this.buildFilter(item, fields)) };
    if ('_not' in filter) return { NOT: this.buildFilter(filter._not, fields) };

    if (filter._id !== undefined && filter._field === undefined) return { id: filter._id };
    if (filter._field !== undefined) {
      return this.buildOperator('_eq', { _field: filter._field, _value: filter._value }, fields);
    }

    for (const op of ['_eq', '_is', '_ne', '_lt', '_gt', '_lte', '_gte', '_between', '_in', '_has', '_like', '_match', '_startsWith', '_endsWith', '_any']) {
      if (op in filter) return this.buildOperator(op, filter[op], fields);
    }
    return {};
  }

  private buildOperator(op: string, spec: any, fields: Record<string, FieldDesc>): any {
    if (op === '_any' || !spec) return {};
    const fieldName = spec._field ?? spec.field;
    if (fieldName === undefined) return {};
    const desc = fields[fieldName];
    if (!desc) return {};
    if (desc.kind === 'json') return this.jsonOperator(op, spec, desc);
    if (op === '_has') return this.wrap(desc, { not: null });

    if (desc.kind === 'array') {
      const values = this.asValues(op === '_in' ? spec._values : spec._value);
      if (op === '_eq' || op === '_is') return { [desc.field]: { has: values[0] } };
      if (op === '_in') return { [desc.field]: { hasSome: values } };
      if (op === '_ne') return { NOT: { [desc.field]: { has: values[0] } } };
      if (op === '_like' || op === '_match') return { [desc.field]: { hasSome: values } };
      return {};
    }

    const raw = spec._value;
    switch (op) {
      case '_eq':
      case '_is':
        return this.wrap(desc, this.cast(raw, desc.type));
      case '_ne':
        return this.wrap(desc, { not: this.cast(raw, desc.type) });
      case '_lt':
        return this.wrap(desc, { lt: this.cast(raw, desc.type) });
      case '_gt':
        return this.wrap(desc, { gt: this.cast(raw, desc.type) });
      case '_lte':
        return this.wrap(desc, { lte: this.cast(raw, desc.type) });
      case '_gte':
        return this.wrap(desc, { gte: this.cast(raw, desc.type) });
      case '_between': {
        const condition: any = {};
        if (spec._from !== undefined) condition.gte = this.cast(spec._from, desc.type);
        if (spec._to !== undefined) condition.lt = this.cast(spec._to, desc.type);
        return this.wrap(desc, condition);
      }
      case '_in':
        return this.wrap(desc, { in: this.asValues(spec._values).map((value) => this.cast(value, desc.type)) });
      case '_like':
      case '_match':
      case '_startsWith':
      case '_endsWith':
        return this.wrap(desc, this.likeCondition(op, raw));
      default:
        return {};
    }
  }

  private jsonOperator(op: string, spec: any, desc: FieldDesc): any {
    const parts = String(desc.field || '').split('.');
    if (parts.length < 2) return {};
    const [root, ...path] = parts;
    const value = spec._value;
    if (value === undefined) return {};
    if (op === '_eq' || op === '_is') return { [root]: { path, equals: value } };
    if (op === '_ne') return { NOT: { [root]: { path, equals: value } } };
    if (op === '_like' || op === '_match') return { [root]: { path, string_contains: String(value) } };
    if (op === '_startsWith') return { [root]: { path, string_starts_with: String(value) } };
    if (op === '_endsWith') return { [root]: { path, string_ends_with: String(value) } };
    if (op === '_in') return { [root]: { path, in: this.asValues(spec._values) } };
    return {};
  }

  private likeCondition(op: string, raw: any): any {
    const value = String(raw ?? '');
    const strip = (text: string) => text.replace(/^\*+|\*+$/g, '');
    if (op === '_startsWith') return { startsWith: strip(value), mode: 'insensitive' };
    if (op === '_endsWith') return { endsWith: strip(value), mode: 'insensitive' };
    const leading = value.startsWith('*');
    const trailing = value.endsWith('*');
    const core = strip(value);
    if (leading && trailing) return { contains: core, mode: 'insensitive' };
    if (trailing) return { startsWith: core, mode: 'insensitive' };
    if (leading) return { endsWith: core, mode: 'insensitive' };
    return { contains: core, mode: 'insensitive' };
  }

  private wrap(desc: FieldDesc, condition: any): any {
    if (!desc || desc.kind === 'json') return {};
    if (desc.kind === 'relation') return { [desc.relation]: { [desc.field]: condition } };
    return { [desc.field]: condition };
  }

  private buildSort(step: any, fields: Record<string, FieldDesc>): any {
    const out: any = {};
    const apply = (field: string, direction: any) => {
      const desc = fields[field];
      if (!desc || desc.kind === 'array' || desc.kind === 'json') return;
      const dir = String(direction).toLowerCase() === 'desc' ? 'desc' : 'asc';
      if (desc.kind === 'relation') out[desc.relation] = { [desc.field]: dir };
      else out[desc.field] = dir;
    };
    const raw = step._fields;
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        for (const [field, direction] of Object.entries(entry)) apply(field, direction);
      }
    } else if (raw && typeof raw === 'object') {
      for (const [field, direction] of Object.entries(raw)) apply(field, direction);
    }
    return Object.keys(out).length ? out : { createdAt: 'desc' };
  }

  private cast(value: any, type: FieldType): any {
    if (value === null || value === undefined || value === '') return value;
    if (type === 'number') return typeof value === 'number' ? value : Number(value);
    if (type === 'boolean') return typeof value === 'boolean' ? value : value === 'true' || value === true;
    if (type === 'date') {
      if (value instanceof Date) return value;
      if (typeof value === 'number') return new Date(value);
      if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value));
      return new Date(value);
    }
    return value;
  }

  private asValues(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
    if (value === undefined || value === null) return [];
    return [value];
  }

  private asList(value: any): any[] {
    return Array.isArray(value) ? value : [value];
  }

  // ---------------------------------------------------------------- includes / output

  private includeFor(model: string) {
    const userRef = { select: { id: true, login: true, name: true } };
    switch (model) {
      case 'case':
        return { status: true, assignee: userRef, createdBy: userRef, _count: { select: { tasks: true, observables: true, procedures: true, alerts: true } } };
      case 'alert':
        return { status: true, assignee: userRef, createdBy: userRef, case: { select: { id: true, number: true, title: true } }, _count: { select: { observables: true, procedures: true } } };
      case 'caseTask':
        return { case: { select: { id: true, number: true, title: true } }, assignee: userRef, _count: { select: { logs: true } } };
      case 'observable':
        return { createdBy: userRef };
      case 'taskLog':
        return { createdBy: userRef, task: { select: { id: true, title: true, caseId: true } } };
      case 'comment':
      case 'procedure':
      case 'page':
        return { createdBy: userRef };
      case 'caseTemplate':
        return { tasks: { orderBy: { order: 'asc' } }, createdBy: userRef };
      default:
        return undefined;
    }
  }

  private async enrich(user: AuthUser, model: string, rows: any[]) {
    if (model === 'procedure') return attachPatterns(this.prisma, rows);
    if (model !== 'taskLog') return rows;
    const ids = rows.map((row) => row.id);
    if (!ids.length) return rows;
    const attachments = await this.prisma.attachment.findMany({ where: { organisationId: user.organisationId, objectType: 'log', objectId: { in: ids } } });
    const byObject = new Map<string, any[]>();
    for (const attachment of attachments) {
      byObject.set(attachment.objectId, [...(byObject.get(attachment.objectId) || []), attachment]);
    }
    return rows.map((row) => ({ ...row, attachments: byObject.get(row.id) || [] }));
  }

  private project(rows: any[], body: any) {
    if (Array.isArray(body?.includeFields) && body.includeFields.length) {
      return rows.map((row) => Object.fromEntries(body.includeFields.map((key: string) => [key, row[key]])));
    }
    if (Array.isArray(body?.excludeFields) && body.excludeFields.length) {
      return rows.map((row) => {
        const copy = { ...row };
        for (const key of body.excludeFields) delete copy[key];
        return copy;
      });
    }
    return rows;
  }
}
