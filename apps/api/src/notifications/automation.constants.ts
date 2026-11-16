export const TRIGGER_NAMES = [
  'AnyEvent',
  'AlertCreated',
  'AlertImported',
  'CaseCreated',
  'CaseUpdated',
  'CaseClosed',
  'CaseAssigneeChanged',
  'TaskAssigned',
  'TaskClosed',
  'ObservableCreated',
  'LogInMyTask',
  'CommentCreated',
  'JobFinished',
  'SlaWarning',
  'SlaBreached',
  'FilteredEvent',
] as const;

export type TriggerName = (typeof TRIGGER_NAMES)[number];

export const NOTIFIER_TYPES = ['webhook', 'slack', 'mattermost', 'teams', 'discord', 'email', 'function'] as const;

export type NotifierType = (typeof NOTIFIER_TYPES)[number];

export const ENDPOINT_TYPES = ['webhook', 'slack', 'mattermost', 'teams', 'discord', 'smtp'] as const;

export type EndpointType = (typeof ENDPOINT_TYPES)[number];

/** Endpoint type required by each notifier type (`function` runs a stored function instead). */
export const NOTIFIER_ENDPOINT_TYPE: Record<string, EndpointType | null> = {
  webhook: 'webhook',
  slack: 'slack',
  mattermost: 'mattermost',
  teams: 'teams',
  discord: 'discord',
  email: 'smtp',
  function: null,
};

export const SECRET_KEYS = ['password', 'token'];

/** Accepts "AnyEvent", { type: "AnyEvent" } and { name: "AnyEvent" }. */
export function normaliseTriggerValue(value: any): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const name = value.name ?? value.type;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Accepts notifier { type } and TheHive's { name }. */
export function normaliseNotifierType(notifier: any): string {
  if (!notifier || typeof notifier !== 'object') return '';
  if (typeof notifier.type === 'string' && notifier.type) return notifier.type;
  if (typeof notifier.name === 'string' && notifier.name) return notifier.name;
  return '';
}

/** TheHive's trigger object may embed the filter. */
export function triggerFilter(config: any): any {
  if (!config) return undefined;
  if (config.filter !== undefined) return config.filter;
  const trigger = config.trigger;
  if (trigger && typeof trigger === 'object' && trigger.filter !== undefined) return trigger.filter;
  return undefined;
}
export const MASK = '********';

export interface NotificationConfig {
  trigger: TriggerName | string;
  filter?: {
    objectType?: string;
    action?: string;
    minSeverity?: number;
    tagsAny?: string[];
  };
  notifiers: any[];
}
