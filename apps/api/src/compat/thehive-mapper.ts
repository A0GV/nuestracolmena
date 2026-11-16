// TheHive 5 output/input mapping.
//
// Every object returned by a compatibility route is the MyHive object plus the
// fields a TheHive 5 client expects (`_id`, `_type`, `_createdAt`, epoch-ms
// dates, `status` as a value string, `assignee` as a login...). Native MyHive
// routes do not use this mapper, so their response shape is untouched.

export const ms = (value: any): any => {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? value : parsed;
};

function loginOf(obj: any): string | null | undefined {
  if (!obj) return undefined;
  if (typeof obj === 'string') return obj;
  return obj.login ?? undefined;
}

function createdBy(obj: any): string | undefined {
  return loginOf(obj?.createdBy) ?? loginOf(obj?.createdById) ?? undefined;
}

function base(obj: any, type: string) {
  if (!obj || typeof obj !== 'object') return obj;
  const out: any = {
    ...obj,
    _id: obj.id ?? obj._id,
    _type: type,
    _createdAt: ms(obj.createdAt ?? obj._createdAt),
    _updatedAt: ms(obj.updatedAt ?? obj.createdAt ?? obj._updatedAt),
  };
  const by = createdBy(obj);
  if (by !== undefined) out._createdBy = by;
  return out;
}

function mapNestedTask(task: any) {
  return task ? mapTask(task) : task;
}

function mapNestedObservable(observable: any) {
  return observable ? mapObservable(observable) : observable;
}

function mapNestedProcedure(procedure: any) {
  return procedure ? mapProcedure(procedure) : procedure;
}

function mapNestedComment(comment: any) {
  return comment ? mapComment(comment) : comment;
}

function mapNestedAttachment(attachment: any) {
  return attachment ? mapAttachment(attachment) : attachment;
}

export function mapAlert(alert: any) {
  if (!alert) return alert;
  const out = base(alert, 'Alert');
  out.status = alert.status?.value ?? alert.stage ?? alert.status;
  out.assignee = loginOf(alert.assignee) ?? alert.assigneeId ?? null;
  out.date = ms(alert.date);
  out.severity = Number(alert.severity);
  out.tlp = Number(alert.tlp);
  out.pap = Number(alert.pap);
  if (alert.sla) out.extraData = { ...(alert.extraData || {}), sla: alert.sla };
  if (alert.observables) out.observables = alert.observables.map(mapNestedObservable);
  if (alert.procedures) out.procedures = alert.procedures.map(mapNestedProcedure);
  if (alert.comments) out.comments = alert.comments.map(mapNestedComment);
  if (alert.case) {
    out.case = {
      ...alert.case,
      _id: alert.case.id ?? alert.case._id,
      _type: 'Case',
      caseId: alert.case.number,
    };
  }
  return out;
}

export function mapCase(item: any) {
  if (!item) return item;
  const out = base(item, 'Case');
  out.status = item.status?.value ?? item.stage ?? item.status;
  out.assignee = loginOf(item.assignee) ?? item.assigneeId ?? null;
  out.severity = Number(item.severity);
  out.tlp = Number(item.tlp);
  out.pap = Number(item.pap);
  out.startDate = ms(item.startDate);
  out.endDate = ms(item.endDate);
  out.dueDate = ms(item.dueDate);
  out.closedAt = ms(item.closedAt);
  if (item.sla) out.extraData = { ...(item.extraData || {}), sla: item.sla };
  if (item.tasks) out.tasks = item.tasks.map(mapNestedTask);
  if (item.observables) out.observables = item.observables.map(mapNestedObservable);
  if (item.procedures) out.procedures = item.procedures.map(mapNestedProcedure);
  if (item.alerts) out.alerts = item.alerts.map(mapAlert);
  if (item.comments) out.comments = item.comments.map(mapNestedComment);
  if (item.attachments) out.attachments = item.attachments.map(mapNestedAttachment);
  return out;
}

export function mapTask(task: any) {
  if (!task) return task;
  const out = base(task, 'Task');
  out.assignee = loginOf(task.assignee) ?? task.assigneeId ?? null;
  out.startDate = ms(task.startDate);
  out.endDate = ms(task.endDate);
  out.dueDate = ms(task.dueDate);
  out.status = task.status; // TheHive task status is already a value string.
  if (task.sla) out.extraData = { ...(task.extraData || {}), sla: task.sla };
  if (task.case) {
    out.case = {
      ...task.case,
      _id: task.case.id ?? task.case._id,
      _type: 'Case',
      caseId: task.case.number,
    };
  }
  if (task.logs) out.logs = task.logs.map(mapLog);
  if (task.attachments) out.attachments = task.attachments.map(mapNestedAttachment);
  return out;
}

export function mapLog(log: any) {
  if (!log) return log;
  const out = base(log, 'Log');
  out.date = ms(log.date);
  out.startDate = ms(log.startDate ?? log.date);
  if (log.attachments) out.attachments = log.attachments.map(mapNestedAttachment);
  if (log.task) out.task = mapTask(log.task);
  return out;
}

export function mapObservable(observable: any) {
  if (!observable) return observable;
  const out = base(observable, 'Observable');
  out.dataType = observable.dataType;
  out.data = observable.data;
  out.startDate = ms(observable.startDate);
  out.sightedAt = ms(observable.sightedAt);
  out.tlp = Number(observable.tlp);
  out.pap = Number(observable.pap);
  if (observable.reports) out.reports = observable.reports;
  if (observable.attachment) out.attachment = mapAttachment(observable.attachment);
  return out;
}

export function mapComment(comment: any) {
  if (!comment) return comment;
  const out = base(comment, 'Comment');
  out.message = comment.message;
  return out;
}

export function mapProcedure(procedure: any) {
  if (!procedure) return procedure;
  const out = base(procedure, 'Procedure');
  out.occurDate = ms(procedure.occurDate);
  out.startDate = ms(procedure.occurDate);
  const pattern = procedure.pattern;
  const patternName = procedure.patternName || pattern?.name || null;
  const url = pattern?.url || (procedure.patternId ? `https://attack.mitre.org/techniques/${String(procedure.patternId).replace(/\./g, '/')}/` : null);
  const tactics = pattern?.tactics || (procedure.tactic ? [procedure.tactic] : []);
  out.patternName = patternName;
  out.tactic = procedure.tactic ?? null;
  out.url = url;
  out.extraData = {
    ...(procedure.extraData || {}),
    pattern: {
      patternId: procedure.patternId,
      name: patternName,
      tactics,
      url,
    },
  };
  return out;
}

export function mapPattern(pattern: any) {
  if (!pattern) return pattern;
  const out = base(pattern, 'Pattern');
  out.patternId = pattern.patternId;
  out.name = pattern.name;
  out.tactics = pattern.tactics || [];
  out.url = pattern.url ?? null;
  out.revoked = !!pattern.revoked;
  out.isSubtechnique = !!pattern.isSubtechnique;
  return out;
}

export function mapPage(page: any) {
  if (!page) return page;
  const out = base(page, 'Page');
  out.category = page.category;
  if (page.caseId) out.caseId = page.caseId;
  out.name = page.title;
  return out;
}

export function mapCaseTemplate(template: any) {
  if (!template) return template;
  const out = base(template, 'CaseTemplate');
  out.severity = Number(template.severity);
  out.tlp = Number(template.tlp);
  out.pap = Number(template.pap);
  if (template.tasks) {
    out.tasks = template.tasks.map((task: any) => ({
      ...task,
      _id: task.id,
      _type: 'Task',
      _createdAt: ms(task.createdAt),
      _updatedAt: ms(task.updatedAt ?? task.createdAt),
    }));
  }
  return out;
}

export function mapCustomField(field: any) {
  if (!field) return field;
  return base(field, 'CustomField');
}

export function mapUser(user: any) {
  if (!user) return user;
  const out = base(user, 'User');
  if (user.organisation) out.organisation = typeof user.organisation === 'string' ? user.organisation : user.organisation.name;
  return out;
}

function attachmentHashes(attachment: any) {
  if (Array.isArray(attachment?.hashes) && attachment.hashes.length) return attachment.hashes;
  return attachment?.sha256 ? [{ algorithm: 'SHA-256', hash: attachment.sha256 }] : [];
}

export function mapAttachment(attachment: any) {
  if (!attachment) return attachment;
  const out = base(attachment, 'Attachment');
  out.name = attachment.filename;
  out.contentType = attachment.contentType;
  out.size = Number(attachment.size);
  out.hashes = attachmentHashes(attachment);
  return out;
}

export function mapAction(job: any) {
  if (!job) return job;
  const payload = job.payload || {};
  const out = base(job, 'Action');
  out.status = job.status;
  out.cortexId = payload.connectorId;
  out.responderId = payload.responderId;
  out.responderName = payload.responderName;
  out.objectType = payload.objectType;
  out.objectId = payload.objectId;
  out.startDate = ms(job.startedAt ?? job.createdAt);
  out.endDate = ms(job.finishedAt);
  out.result = job.result;
  return out;
}

export function mapObservableType(type: any) {
  return {
    ...type,
    _id: type.id ?? type.name,
    _type: 'ObservableType',
    _createdAt: ms(type.createdAt ?? Date.now()),
    _updatedAt: ms(type.updatedAt ?? type.createdAt ?? Date.now()),
  };
}

const MAPPERS: Record<string, (value: any) => any> = {
  alert: mapAlert,
  case: mapCase,
  caseTask: mapTask,
  taskLog: mapLog,
  observable: mapObservable,
  comment: mapComment,
  procedure: mapProcedure,
  pattern: mapPattern,
  page: mapPage,
  caseTemplate: mapCaseTemplate,
  customField: mapCustomField,
  user: mapUser,
  attachment: mapAttachment,
  job: mapAction,
};

export function mapModel(model: string, value: any) {
  const mapper = MAPPERS[model];
  return mapper ? mapper(value) : value;
}

export function mapModelList(model: string, values: any[]) {
  return (values || []).map((value) => mapModel(model, value));
}

// ---------------------------------------------------------------- input helpers

function splitTags(value: any): string[] {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((tag) => tag.trim()).filter(Boolean);
  return [];
}

/** TheHive accepts custom fields as `{ ref: value }` or `[{ name: ref, value }]`. */
export function normaliseCustomFields(value: any): any {
  if (Array.isArray(value)) {
    const out: Record<string, any> = {};
    for (const field of value) {
      if (!field || typeof field !== 'object') continue;
      const key = field.name ?? field.reference ?? field.ref;
      if (key !== undefined) out[key] = field.value;
    }
    return out;
  }
  if (value && typeof value === 'object') return value;
  return value;
}

/** TheHive allows `data` to be an array: one observable must be created per value. */
export function normaliseObservables(value: any, defaults: any = {}): any[] {
  if (!Array.isArray(value)) return [];
  const out: any[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const dataValues = Array.isArray(item.data) ? item.data : [item.data];
    for (const dataValue of dataValues) {
      if (dataValue === undefined) continue;
      out.push({
        ...defaults,
        ...item,
        data: dataValue,
        tags: splitTags(item.tags),
        tlp: item.tlp !== undefined ? Number(item.tlp) : defaults.tlp,
        pap: item.pap !== undefined ? Number(item.pap) : defaults.pap,
      });
    }
  }
  return out;
}

export function normaliseAlertInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  const body: any = { ...input };
  if (body.customFields !== undefined) body.customFields = normaliseCustomFields(body.customFields);
  if (body.tags !== undefined) body.tags = splitTags(body.tags);
  if (body.addTags !== undefined) body.addTags = splitTags(body.addTags);
  if (body.removeTags !== undefined) body.removeTags = splitTags(body.removeTags);
  if (body.observables !== undefined) {
    body.observables = normaliseObservables(body.observables, { tlp: body.tlp, pap: body.pap });
  }
  return body;
}

export function normaliseCaseInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  const body: any = { ...input };
  if (body.customFields !== undefined) body.customFields = normaliseCustomFields(body.customFields);
  if (body.tags !== undefined) body.tags = splitTags(body.tags);
  if (body.addTags !== undefined) body.addTags = splitTags(body.addTags);
  if (body.removeTags !== undefined) body.removeTags = splitTags(body.removeTags);
  if (body.observables !== undefined) body.observables = normaliseObservables(body.observables);
  return body;
}

export function normaliseTaskInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  const body: any = { ...input };
  if (body.tags !== undefined) body.tags = splitTags(body.tags);
  return body;
}

export function normaliseObservableInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  const body: any = { ...input };
  if (body.tags !== undefined) body.tags = splitTags(body.tags);
  return body;
}

export function normaliseCommentInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  return { ...input };
}

// ---------------------------------------------------------------- TheHive 4 (v0)

function base4(obj: any, type: string) {
  if (!obj || typeof obj !== 'object') return obj;
  return {
    ...obj,
    id: obj.id ?? obj._id,
    _id: obj.id ?? obj._id,
    _type: type,
    createdAt: ms(obj.createdAt),
    updatedAt: ms(obj.updatedAt ?? obj.createdAt),
  };
}

export function alertStatus4(value: any): string {
  switch (value) {
    case 'InProgress':
    case 'Pending':
    case 'Updated':
      return 'Updated';
    case 'Imported':
      return 'Imported';
    case 'Ignored':
    case 'FalsePositive':
    case 'Duplicate':
      return 'Ignored';
    case undefined:
    case null:
    case '':
      return 'New';
    default:
      return String(value);
  }
}

export function alertStatus4Input(value: any): any {
  switch (value) {
    case 'Updated':
      return 'InProgress';
    case 'Open':
      return 'New';
    case 'Resolved':
      return 'Imported';
    default:
      return value;
  }
}

export function caseStatus4(item: any): string {
  const status = item?.status?.value ?? item?.status;
  if (item?.stage === 'Deleted' || status === 'Deleted') return 'Deleted';
  if (
    item?.stage === 'Closed' ||
    item?.closedAt ||
    ['TruePositive', 'FalsePositive', 'Indeterminate', 'Duplicated', 'Other', 'Resolved', 'Deleted'].includes(status)
  ) {
    return 'Resolved';
  }
  return 'Open';
}

export function mapAttachment4(attachment: any) {
  if (!attachment) return attachment;
  const out = base4(attachment, 'attachment');
  out.name = attachment.filename;
  out.contentType = attachment.contentType;
  out.size = Number(attachment.size);
  out.hashes = attachmentHashes(attachment);
  return out;
}

export function mapArtifact4(observable: any) {
  if (!observable) return observable;
  const out = base4(observable, 'case_artifact');
  out.createdBy = loginOf(observable.createdBy) ?? observable.createdById ?? undefined;
  out.dataType = observable.dataType;
  out.data = observable.data;
  out.message = observable.message ?? '';
  out.tlp = Number(observable.tlp);
  out.pap = Number(observable.pap);
  out.ioc = !!observable.ioc;
  out.sighted = !!observable.sighted;
  out.tags = observable.tags || [];
  out.startDate = ms(observable.startDate);
  out.sightedAt = ms(observable.sightedAt);
  if (observable.attachment) out.attachment = mapAttachment4(observable.attachment);
  return out;
}

export function mapLog4(log: any) {
  if (!log) return log;
  const out = base4(log, 'case_task_log');
  out.createdBy = loginOf(log.createdBy) ?? log.createdById ?? undefined;
  out.message = log.message;
  out.date = ms(log.date);
  out.startDate = ms(log.date ?? log.startDate);
  out.attachments = (log.attachments || []).map(mapAttachment4);
  if (log.task) {
    out.task = {
      id: log.task.id,
      _id: log.task.id,
      _type: 'case_task',
      title: log.task.title,
      caseId: log.task.caseId,
    };
  }
  return out;
}

export function mapTask4(task: any) {
  if (!task) return task;
  const out = base4(task, 'case_task');
  out.assignee = loginOf(task.assignee) ?? task.assigneeId ?? null;
  out.createdBy = loginOf(task.createdBy) ?? task.createdById ?? undefined;
  out.startDate = ms(task.startDate);
  out.endDate = ms(task.endDate);
  out.dueDate = ms(task.dueDate);
  out.status = task.status;
  if (task.case) {
    out.case = {
      id: task.case.id,
      _id: task.case.id,
      _type: 'case',
      caseId: task.case.number,
      title: task.case.title,
    };
  }
  if (task.logs) out.logs = task.logs.map(mapLog4);
  if (task.attachments) out.attachments = task.attachments.map(mapAttachment4);
  return out;
}

export function mapAlert4(alert: any) {
  if (!alert) return alert;
  const out = base4(alert, 'alert');
  out.status = alertStatus4(alert.status?.value ?? alert.stage ?? alert.status);
  out.assignee = loginOf(alert.assignee) ?? alert.assigneeId ?? null;
  out.createdBy = loginOf(alert.createdBy) ?? alert.createdById ?? undefined;
  out.date = ms(alert.date);
  out.severity = Number(alert.severity);
  out.tlp = Number(alert.tlp);
  out.pap = Number(alert.pap);
  out.tags = alert.tags || [];
  out.artifacts = (alert.observables || []).map(mapArtifact4);
  if (alert.case) {
    out.case = {
      id: alert.case.id,
      _id: alert.case.id,
      _type: 'case',
      caseId: alert.case.number,
      title: alert.case.title,
    };
  }
  return out;
}

export function mapCase4(item: any) {
  if (!item) return item;
  const out = base4(item, 'case');
  out.caseId = item.number;
  out.status = caseStatus4(item);
  out.assignee = loginOf(item.assignee) ?? item.assigneeId ?? null;
  out.createdBy = loginOf(item.createdBy) ?? item.createdById ?? undefined;
  out.severity = Number(item.severity);
  out.tlp = Number(item.tlp);
  out.pap = Number(item.pap);
  out.startDate = ms(item.startDate);
  out.endDate = ms(item.endDate);
  out.dueDate = ms(item.dueDate);
  out.closedAt = ms(item.closedAt);
  out.tags = item.tags || [];
  out.tasks = (item.tasks || []).map(mapTask4);
  out.artifacts = (item.observables || []).map(mapArtifact4);
  if (item.alerts) out.alerts = item.alerts.map(mapAlert4);
  return out;
}

export function mapCaseTemplate4(template: any) {
  if (!template) return template;
  const out = base4(template, 'caseTemplate');
  out.severity = Number(template.severity);
  out.tlp = Number(template.tlp);
  out.pap = Number(template.pap);
  out.tags = template.tags || [];
  out.tasks = (template.tasks || []).map((task: any) => ({
    ...base4(task, 'case_task'),
    title: task.title,
    group: task.group,
    description: task.description,
    order: Number(task.order),
    dueDays: task.dueDays,
    mandatory: !!task.mandatory,
  }));
  return out;
}

export function mapUser4(user: any) {
  if (!user) return user;
  const out = base4(user, 'user');
  out.login = user.login;
  out.name = user.name;
  out.email = user.email ?? null;
  return out;
}

const LEGACY_MAPPERS: Record<string, (value: any) => any> = {
  alert: mapAlert4,
  case: mapCase4,
  caseTask: mapTask4,
  taskLog: mapLog4,
  observable: mapArtifact4,
  caseTemplate: mapCaseTemplate4,
  user: mapUser4,
  attachment: mapAttachment4,
};

export function toTheHive4(model: string, value: any) {
  const mapper = LEGACY_MAPPERS[model];
  return mapper ? mapper(value) : value;
}

export function toTheHive4List(model: string, values: any[]) {
  return (values || []).map((value) => toTheHive4(model, value));
}

const TYPED_CUSTOM_FIELD_KEYS = ['string', 'number', 'integer', 'float', 'boolean', 'date', 'text'];

/** Flattens TheHive 4 typed custom fields (`{ ref: { string: 'v', order: 0 } }`). */
export function normaliseTheHive4CustomFields(value: any): any {
  const flat = normaliseCustomFields(value);
  if (!flat || typeof flat !== 'object' || Array.isArray(flat)) return flat;
  const out: Record<string, any> = {};
  for (const [reference, raw] of Object.entries(flat)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const typed = TYPED_CUSTOM_FIELD_KEYS.find((key) => key in (raw as any));
      out[reference] = typed ? (raw as any)[typed] : raw;
    } else {
      out[reference] = raw;
    }
  }
  return out;
}

export function normaliseTheHive4AlertInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  const body: any = normaliseAlertInput({ ...input });
  if (input.artifacts !== undefined && input.observables === undefined) {
    body.observables = normaliseObservables(input.artifacts, { tlp: input.tlp, pap: input.pap });
  }
  if (input.customFields !== undefined) body.customFields = normaliseTheHive4CustomFields(input.customFields);
  if (input.status !== undefined) body.status = alertStatus4Input(input.status);
  delete body.artifacts;
  return body;
}

export function normaliseTheHive4CaseInput(input: any): any {
  if (!input || typeof input !== 'object') return input;
  const body: any = normaliseCaseInput({ ...input });
  if (input.artifacts !== undefined && input.observables === undefined) {
    body.observables = normaliseObservables(input.artifacts);
  }
  if (input.customFields !== undefined) body.customFields = normaliseTheHive4CustomFields(input.customFields);
  delete body.artifacts;
  return body;
}

export const normaliseTheHive4TaskInput = normaliseTaskInput;
export const normaliseTheHive4ObservableInput = normaliseObservableInput;
