import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService, HiveEvent } from '../events/events.module';
import { DeliveryService } from './delivery.service';
import { normaliseNotifierType, normaliseTriggerValue, triggerFilter } from './automation.constants';
import { FunctionsService } from '../functions/functions.service';
import { ALL_PERMISSIONS } from '../common/permissions';
import { AuthUser } from '../common/decorators/auth.decorators';

@Injectable()
export class NotificationsEngine implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('NotificationsEngine');
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly delivery: DeliveryService,
    private readonly functions: FunctionsService,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.events.on((event) => {
      // Never slow down or break the request that produced the event.
      setImmediate(() => {
        this.handle(event).catch((e) => this.logger.warn(`Notification engine: ${e?.message || e}`));
      });
    });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  private async handle(event: HiveEvent) {
    if (!event.organisationId) return;
    const notifications = await this.prisma.notification.findMany({
      where: { organisationId: event.organisationId, enabled: true },
    });
    if (!notifications.length) return;

    const matched = notifications.filter((notification) => this.matches(notification.config as any, event));
    if (!matched.length) return;

    const org = await this.prisma.organisation.findUnique({ where: { id: event.organisationId }, select: { name: true } });
    const organisation = org?.name || event.organisationId;

    await Promise.allSettled(
      matched.map(async (notification) => {
        const config: any = notification.config || {};
        const notifiers: any[] = Array.isArray(config.notifiers) ? config.notifiers : [];
        await Promise.allSettled(
          notifiers.map(async (stored) => {
            const notifier = { ...stored, type: normaliseNotifierType(stored) };
            if (notifier.type === 'function') {
              await this.runFunctionNotifier(notification, notifier, event, organisation);
              return;
            }
            const endpoint = await this.prisma.endpoint.findFirst({
              where: { id: notifier.endpointId, OR: [{ organisationId: event.organisationId }, { organisationId: null }] },
            });
            if (!endpoint) {
              this.logger.warn(`Notification ${notification.name}: endpoint ${notifier.endpointId} not found`);
              return;
            }
            const result = await this.delivery.deliver({ notification, notifier, endpoint, event, organisation });
            if (!result.ok) {
              this.logger.warn(`Notification ${notification.name}: ${notifier.type} failed after ${result.attempts} attempt(s): ${result.error}`);
            }
          }),
        );
      }),
    );
  }

  private async runFunctionNotifier(notification: any, notifier: any, event: HiveEvent, organisation: string) {
    if (!event.organisationId) return;
    const fn = await this.prisma.function.findFirst({
      where: { id: notifier.functionId, organisationId: event.organisationId, kind: 'notification' },
    });
    if (!fn) {
      this.logger.warn(`Notification ${notification.name}: function ${notifier.functionId} not found`);
      return;
    }
    const user = await this.functionUser(notification, event);
    if (!user) {
      this.logger.warn(`Notification ${notification.name}: no user available to run function ${fn.name}`);
      return;
    }
    const built = await this.delivery.buildScope(event, organisation);
    const result = await this.functions.run(
      fn,
      { event: built.scope.event, object: built.scope.object, context: built.scope.context },
      { user, dryRun: fn.mode === 'DryRun' },
    );
    if (result.error || result.timedOut) {
      this.logger.warn(`Notification ${notification.name}: function ${fn.name} failed: ${result.error || 'timeout'}`);
    }
  }

  private async functionUser(notification: any, event: HiveEvent): Promise<AuthUser | null> {
    const userId = notification.createdById || event.actorId;
    if (!userId || !event.organisationId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { profile: true } } },
    });
    if (!user || user.locked) return null;
    const membership =
      user.memberships.find((item) => item.organisationId === event.organisationId) || user.memberships[0];
    if (!membership) return null;
    const isPlatformAdmin = membership.profile.type === 'admin';
    return {
      id: user.id,
      login: user.login,
      name: user.name,
      organisationId: event.organisationId,
      profileId: membership.profileId,
      profileName: membership.profile.name,
      permissions: isPlatformAdmin ? ALL_PERMISSIONS : ((membership.profile.permissions as string[]) || []),
      isPlatformAdmin,
    };
  }

  matches(config: any, event: HiveEvent): boolean {
    const trigger = normaliseTriggerValue(config?.trigger);
    if (!trigger) return false;
    if (!this.matchesTrigger(trigger, event)) return false;
    return this.matchesFilter(triggerFilter(config), event);
  }

  private matchesTrigger(trigger: string, event: HiveEvent): boolean {
    const action = event.action;
    const details: any = event.details || {};
    switch (trigger) {
      case 'AnyEvent':
        return true;
      case 'AlertCreated':
        return event.objectType === 'Alert' && action === 'create';
      case 'AlertImported':
        return event.objectType === 'Alert' && ['import-to-case', 'merge-alert', 'import'].includes(action);
      case 'CaseCreated':
        return event.objectType === 'Case' && action === 'create';
      case 'CaseUpdated':
        return event.objectType === 'Case' && ['update', 'reopen', 'close', 'merge'].includes(action);
      case 'CaseClosed':
        return event.objectType === 'Case' && (action === 'close' || (action === 'update' && String(details.stage || '').toLowerCase() === 'closed'));
      case 'CaseAssigneeChanged':
        return event.objectType === 'Case' && action === 'update' && !!details.assigneeId && details.assigneeId !== details.previousAssigneeId;
      case 'TaskAssigned':
        return (
          event.objectType === 'Task' &&
          ['create', 'update'].includes(action) &&
          !!details.assigneeId &&
          (action === 'create' || details.assigneeId !== details.previousAssigneeId)
        );
      case 'TaskClosed':
        return event.objectType === 'Task' && (String(details.status || '').toLowerCase() === 'completed' || action === 'close');
      case 'ObservableCreated':
        return event.objectType === 'Observable' && action === 'create';
      case 'LogInMyTask':
        return event.objectType === 'Log' && action === 'create' && !!details.taskAssigneeId && details.taskAssigneeId !== event.actorId;
      case 'CommentCreated':
        return event.objectType === 'Comment' && action === 'create';
      case 'JobFinished':
        return event.objectType === 'Job' && action === 'finish';
      case 'SlaWarning':
        return action === 'SlaWarning';
      case 'SlaBreached':
        return action === 'SlaBreached';
      case 'FilteredEvent':
        return true;
      default:
        return false;
    }
  }

  private matchesFilter(filter: any, event: HiveEvent): boolean {
    if (!filter || typeof filter !== 'object') return true;
    if (filter.objectType && String(filter.objectType) !== event.objectType) return false;
    if (filter.action && String(filter.action) !== event.action) return false;
    const details: any = event.details || {};
    if (filter.minSeverity !== undefined && filter.minSeverity !== null) {
      const severity = Number(details.severity ?? event.object?.severity ?? event.context?.severity ?? 0);
      if (!(severity >= Number(filter.minSeverity))) return false;
    }
    if (Array.isArray(filter.tagsAny) && filter.tagsAny.length) {
      const tags: string[] = details.tags || event.object?.tags || event.context?.tags || [];
      const wanted = filter.tagsAny.map((tag: any) => String(tag).toLowerCase());
      if (!tags.some((tag) => wanted.includes(String(tag).toLowerCase()))) return false;
    }
    return true;
  }
}
