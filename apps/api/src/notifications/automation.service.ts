import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { HiveEvent } from '../events/events.module';
import {
  ENDPOINT_TYPES,
  MASK,
  NOTIFIER_ENDPOINT_TYPE,
  NOTIFIER_TYPES,
  TRIGGER_NAMES,
  normaliseNotifierType,
  normaliseTriggerValue,
  triggerFilter,
} from './automation.constants';
import { DeliveryService, maskSecrets, mergeConfig } from './delivery.service';
import { FunctionsService } from '../functions/functions.service';

@Injectable()
export class AutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
    private readonly functions: FunctionsService,
  ) {}

  // ---------------------------------------------------------------- notifications

  async listNotifications(user: AuthUser) {
    return this.prisma.notification.findMany({ where: { organisationId: user.organisationId }, orderBy: { createdAt: 'desc' } });
  }

  async createNotification(user: AuthUser, data: any) {
    if (!data?.name?.trim()) throw new BadRequestException('name is required');
    const config = await this.validateNotificationConfig(user, data.config);
    return this.prisma.notification.create({
      data: { organisationId: user.organisationId, name: data.name, enabled: data.enabled ?? true, config, createdById: user.id },
    });
  }

  async updateNotification(user: AuthUser, id: string, data: any) {
    const existing = await this.getNotification(user, id);
    const config = data.config !== undefined ? await this.validateNotificationConfig(user, mergeConfig(existing.config, data.config)) : existing.config;
    return this.prisma.notification.update({
      where: { id },
      data: { name: data.name ?? undefined, enabled: data.enabled ?? undefined, config },
    });
  }

  async deleteNotification(user: AuthUser, id: string) {
    await this.getNotification(user, id);
    await this.prisma.notification.delete({ where: { id } });
    return { ok: true };
  }

  async testNotification(user: AuthUser, id: string) {
    const notification = await this.getNotification(user, id);
    const config: any = notification.config || {};
    const organisation = await this.organisationName(user.organisationId);
    const event = await this.syntheticEvent(user);
    const results: any[] = [];
    for (const stored of Array.isArray(config.notifiers) ? config.notifiers : []) {
      const notifier = { ...stored, type: normaliseNotifierType(stored) };
      if (notifier.type === 'function') {
        const fn = await this.prisma.function.findFirst({
          where: { id: notifier.functionId, organisationId: user.organisationId, kind: 'notification' },
        });
        if (!fn) {
          results.push({ type: notifier.type, functionId: notifier.functionId, ok: false, error: 'Function not found' });
          continue;
        }
        const built = await this.delivery.buildScope(event, organisation);
        const result = await this.functions.run(
          fn,
          { event: built.scope.event, object: built.scope.object, context: built.scope.context },
          { user, dryRun: fn.mode === 'DryRun' },
        );
        results.push({
          type: notifier.type,
          functionId: fn.id,
          functionName: fn.name,
          ok: !result.error && !result.timedOut,
          error: result.error || undefined,
          durationMs: result.durationMs,
        });
        continue;
      }
      const endpoint = await this.prisma.endpoint.findFirst({
        where: { id: notifier.endpointId, OR: [{ organisationId: user.organisationId }, { organisationId: null }] },
      });
      if (!endpoint) {
        results.push({ type: notifier.type, endpointId: notifier.endpointId, ok: false, error: 'Endpoint not found' });
        continue;
      }
      const result = await this.delivery.deliver({ notification, notifier, endpoint, event, organisation, test: true });
      results.push({ type: notifier.type, endpointId: endpoint.id, endpointName: endpoint.name, ...result });
    }
    return { ok: results.every((r) => r.ok), results };
  }

  async deliveries(user: AuthUser, notificationId?: string, limit = 50) {
    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.prisma.job.findMany({
      where: {
        organisationId: user.organisationId,
        type: 'notification',
        ...(notificationId ? { payload: { path: ['notificationId'], equals: notificationId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async syntheticEvent(user: AuthUser): Promise<HiveEvent> {
    const latest = await this.prisma.case.findFirst({
      where: { organisationId: user.organisationId },
      include: { status: true, assignee: true, createdBy: true },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    if (latest) {
      return {
        id: randomUUID(),
        action: 'create',
        objectType: 'Case',
        objectId: latest.id,
        rootId: latest.id,
        rootType: 'Case',
        organisationId: user.organisationId,
        actorId: user.id,
        actorLogin: user.login,
        details: { test: true, number: latest.number, title: latest.title, severity: latest.severity, tags: latest.tags },
        date: now,
        object: latest,
      };
    }
    const fakeId = randomUUID();
    return {
      id: randomUUID(),
      action: 'create',
      objectType: 'Case',
      objectId: fakeId,
      rootId: fakeId,
      rootType: 'Case',
      organisationId: user.organisationId,
      actorId: user.id,
      actorLogin: user.login,
      details: { test: true, title: 'Test notification', severity: 2, tags: ['test'] },
      date: now,
      object: {
        id: fakeId,
        number: 0,
        title: 'Test notification',
        description: 'Synthetic event generated by the notification test',
        severity: 2,
        tlp: 2,
        pap: 2,
        tags: ['test'],
        status: 'New',
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  private async getNotification(user: AuthUser, id: string) {
    const notification = await this.prisma.notification.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  private async validateNotificationConfig(user: AuthUser, raw: any) {
    const config = parseJsonObject(raw);
    const trigger = normaliseTriggerValue(config.trigger);
    if (!trigger || !(TRIGGER_NAMES as readonly string[]).includes(trigger)) {
      throw new BadRequestException(`Unknown trigger "${trigger || JSON.stringify(config.trigger)}". Allowed: ${TRIGGER_NAMES.join(', ')}`);
    }
    const filter = triggerFilter(config);
    if (filter !== undefined && filter !== null) {
      if (typeof filter !== 'object' || Array.isArray(filter)) throw new BadRequestException('filter must be an object');
      if (filter.minSeverity !== undefined && Number.isNaN(Number(filter.minSeverity))) {
        throw new BadRequestException('filter.minSeverity must be a number');
      }
      if (filter.tagsAny !== undefined && !Array.isArray(filter.tagsAny)) {
        throw new BadRequestException('filter.tagsAny must be an array of strings');
      }
    }
    if (!Array.isArray(config.notifiers)) throw new BadRequestException('config.notifiers must be an array');
    const notifiers: any[] = [];
    for (const [index, notifier] of config.notifiers.entries()) {
      const type = normaliseNotifierType(notifier);
      if (!type || !(NOTIFIER_TYPES as readonly string[]).includes(type)) {
        throw new BadRequestException(`Unknown notifier type "${type || JSON.stringify(notifier)}" at notifiers[${index}]. Allowed: ${NOTIFIER_TYPES.join(', ')}`);
      }
      if (type === 'function') {
        if (!notifier.functionId) throw new BadRequestException(`notifiers[${index}] (function) is missing functionId`);
        const fn = await this.prisma.function.findFirst({
          where: { id: notifier.functionId, organisationId: user.organisationId, kind: 'notification' },
        });
        if (!fn) throw new BadRequestException(`Notification function not found for notifiers[${index}]: ${notifier.functionId}`);
        const normalized = { ...notifier, type };
        delete normalized.name;
        notifiers.push(normalized);
        continue;
      }
      if (!notifier.endpointId) throw new BadRequestException(`notifiers[${index}] is missing endpointId`);
      const endpoint = await this.prisma.endpoint.findFirst({
        where: { id: notifier.endpointId, OR: [{ organisationId: user.organisationId }, { organisationId: null }] },
      });
      if (!endpoint) throw new BadRequestException(`Endpoint not found for notifiers[${index}]: ${notifier.endpointId}`);
      const expected = NOTIFIER_ENDPOINT_TYPE[type];
      if (endpoint.type !== expected) {
        throw new BadRequestException(`notifiers[${index}] (${type}) requires an endpoint of type "${expected}", got "${endpoint.type}"`);
      }
      if (type === 'email') {
        if (!Array.isArray(notifier.to) || !notifier.to.filter(Boolean).length) {
          throw new BadRequestException(`notifiers[${index}] (email) requires at least one recipient in "to"`);
        }
      }
      const normalized = { ...notifier, type, to: notifier.to };
      delete normalized.name;
      notifiers.push(normalized);
    }
    return { ...config, trigger, ...(filter !== undefined ? { filter } : {}), notifiers };
  }

  // ---------------------------------------------------------------- endpoints

  async listEndpoints(user: AuthUser) {
    const endpoints = await this.prisma.endpoint.findMany({
      where: { type: { notIn: ['cortex', 'misp'] }, OR: [{ organisationId: user.organisationId }, { organisationId: null }] },
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((endpoint) => this.presentEndpoint(endpoint));
  }

  async createEndpoint(user: AuthUser, data: any) {
    if (['cortex', 'misp'].includes(data?.type)) throw new BadRequestException('Use Administración → Cortex & MISP to add Cortex/MISP servers');
    if (!data?.name?.trim()) throw new BadRequestException('name is required');
    if (!(ENDPOINT_TYPES as readonly string[]).includes(data.type)) {
      throw new BadRequestException(`Unknown endpoint type "${data.type}". Allowed: ${ENDPOINT_TYPES.join(', ')}`);
    }
    const config = validateEndpointConfig(data.type, parseJsonObject(data.config));
    const endpoint = await this.prisma.endpoint.create({
      data: { organisationId: user.organisationId, name: data.name, type: data.type, config, createdById: user.id },
    });
    return this.presentEndpoint(endpoint);
  }

  async updateEndpoint(user: AuthUser, id: string, data: any) {
    const existing = await this.getEndpoint(user, id);
    if (['cortex', 'misp'].includes(existing.type)) throw new BadRequestException('Cortex/MISP servers are managed in Administración → Cortex & MISP');
    if (data.type !== undefined && data.type !== existing.type) {
      throw new BadRequestException('Endpoint type cannot be changed; create a new endpoint instead');
    }
    const config = data.config !== undefined ? validateEndpointConfig(existing.type, mergeConfig(existing.config, parseJsonObject(data.config))) : existing.config;
    const endpoint = await this.prisma.endpoint.update({
      where: { id },
      data: { name: data.name ?? undefined, config },
    });
    return this.presentEndpoint(endpoint);
  }

  async deleteEndpoint(user: AuthUser, id: string) {
    const existing = await this.getEndpoint(user, id);
    if (['cortex', 'misp'].includes(existing.type)) throw new BadRequestException('Cortex/MISP servers are managed in Administración → Cortex & MISP');
    await this.prisma.endpoint.delete({ where: { id } });
    return { ok: true };
  }

  async testEndpoint(user: AuthUser, id: string, body: any) {
    const endpoint = await this.getEndpoint(user, id);
    if (['cortex', 'misp'].includes(endpoint.type)) throw new BadRequestException('Cortex/MISP servers are managed in Administración → Cortex & MISP');
    return this.delivery.probeEndpoint(endpoint, body || {});
  }

  private async getEndpoint(user: AuthUser, id: string) {
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id, OR: [{ organisationId: user.organisationId }, { organisationId: null }] },
    });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return endpoint;
  }

  private presentEndpoint(endpoint: any) {
    return { ...endpoint, config: maskSecrets(endpoint.config || {}) };
  }

  private async organisationName(organisationId: string) {
    const org = await this.prisma.organisation.findUnique({ where: { id: organisationId }, select: { name: true } });
    return org?.name || organisationId;
  }
}

function parseJsonObject(value: any): any {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fallthrough
  }
  throw new BadRequestException('config must be a valid JSON object');
}

function validateEndpointConfig(type: string, config: any) {
  const cfg = config && typeof config === 'object' ? config : {};
  if (type === 'webhook') {
    if (!cfg.url) throw new BadRequestException('webhook endpoint requires config.url');
    if (cfg.auth?.type && !['none', 'bearer', 'basic'].includes(cfg.auth.type)) {
      throw new BadRequestException('config.auth.type must be one of none, bearer, basic');
    }
  } else if (['slack', 'mattermost', 'teams', 'discord'].includes(type)) {
    if (!cfg.webhookUrl) throw new BadRequestException(`${type} endpoint requires config.webhookUrl`);
  } else if (type === 'smtp') {
    if (!cfg.host) throw new BadRequestException('smtp endpoint requires config.host');
    if (!cfg.port) throw new BadRequestException('smtp endpoint requires config.port');
    if (!cfg.from) throw new BadRequestException('smtp endpoint requires config.from');
  } else {
    throw new BadRequestException(`Unknown endpoint type "${type}". Allowed: ${ENDPOINT_TYPES.join(', ')}`);
  }
  return cfg;
}

export { MASK };
