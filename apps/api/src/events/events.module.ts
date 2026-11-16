import { Global, Injectable, Module } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const HIVE_OBJECT_TYPES = [
  'Alert',
  'Case',
  'Task',
  'Log',
  'Observable',
  'Comment',
  'Page',
  'Procedure',
  'Attachment',
  'Job',
] as const;

export type HiveObjectType = (typeof HIVE_OBJECT_TYPES)[number];

export interface HiveEvent {
  id: string;
  action: string;
  objectType: HiveObjectType | string;
  objectId: string | null;
  rootId: string | null;
  rootType?: string | null;
  organisationId: string | null;
  actorId: string | null;
  actorLogin?: string | null;
  details: any;
  date: Date;
  /** Raw snapshot carried by the emitter (used for deletions / synthetic events). */
  object?: any;
  /** Raw root snapshot carried by the emitter. */
  context?: any;
}

export type HiveEventHandler = (event: HiveEvent) => void;

const OBJECT_TYPE_MAP: Record<string, HiveObjectType> = {
  alert: 'Alert',
  case: 'Case',
  task: 'Task',
  casetask: 'Task',
  log: 'Log',
  tasklog: 'Log',
  observable: 'Observable',
  obs: 'Observable',
  comment: 'Comment',
  page: 'Page',
  procedure: 'Procedure',
  ttp: 'Procedure',
  attachment: 'Attachment',
  job: 'Job',
};

/** Normalises the lower-case names used by older audit calls to TheHive names. */
export function normaliseObjectType(value: string | null | undefined): string {
  if (!value) return '';
  return OBJECT_TYPE_MAP[String(value).toLowerCase()] ?? String(value);
}

/**
 * Internal event bus. Emitters (audit service) call `emit`; consumers
 * (notification engine) call `on`. Handlers are isolated so a broken consumer
 * can never break the request that produced the event.
 */
@Injectable()
export class EventsService {
  private readonly emitter = new EventEmitter();
  private readonly handlers = new Set<HiveEventHandler>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(input: Partial<HiveEvent> & { action: string; objectType: string }): HiveEvent {
    const event: HiveEvent = {
      id: input.id || randomUUID(),
      action: input.action,
      objectType: normaliseObjectType(input.objectType),
      objectId: input.objectId ?? null,
      rootId: input.rootId ?? null,
      rootType: input.rootType ?? null,
      organisationId: input.organisationId ?? null,
      actorId: input.actorId ?? null,
      actorLogin: input.actorLogin ?? null,
      details: input.details ?? {},
      date: input.date instanceof Date ? input.date : new Date(input.date || Date.now()),
      object: input.object,
      context: input.context,
    };
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A consumer must never break the emitter.
      }
    }
    try {
      this.emitter.emit('event', event);
    } catch {
      // same as above
    }
    return event;
  }

  on(handler: HiveEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

@Global()
@Module({
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
