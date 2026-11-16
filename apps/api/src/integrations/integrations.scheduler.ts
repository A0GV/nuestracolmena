import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { ConnectorsService } from './connectors.service';
import { CortexService } from './cortex.service';
import { MispService } from './misp.service';

/**
 * Background work for integrations:
 *  - every 5s: refresh Cortex analyzer/responder jobs that are still running
 *  - every 60s: run MISP feeders (AlertFeeder with config.type = 'misp') whose interval elapsed
 * Disable with INTEGRATIONS_SCHEDULER=false.
 */
@Injectable()
export class IntegrationsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Integrations');
  private timers: NodeJS.Timeout[] = [];
  private cortexBusy = false;
  private feedersBusy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly cortex: CortexService,
    private readonly misp: MispService,
  ) {}

  onModuleInit() {
    if (process.env.INTEGRATIONS_SCHEDULER === 'false') return;
    this.timers.push(setInterval(() => this.tickCortex(), 5000));
    this.timers.push(setInterval(() => this.tickFeeders(), 60000));
    setTimeout(() => this.tickFeeders(), 15000);
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  private async tickCortex() {
    if (this.cortexBusy) return;
    this.cortexBusy = true;
    try {
      await this.cortex.pollPending();
    } catch (e: any) {
      this.logger.warn(`Cortex poll failed: ${e.message}`);
    } finally {
      this.cortexBusy = false;
    }
  }

  private async tickFeeders() {
    if (this.feedersBusy) return;
    this.feedersBusy = true;
    try {
      const feeders = await this.prisma.alertFeeder.findMany({ where: { enabled: true, config: { path: ['type'], equals: 'misp' } } });
      for (const f of feeders) {
        const cfg: any = f.config || {};
        const interval = Math.max(1, Number(cfg.intervalMinutes || 15)) * 60000;
        const lastRun = cfg.lastRunAt ? new Date(cfg.lastRunAt).getTime() : 0;
        if (Date.now() - lastRun < interval) continue;
        await this.runFeeder(f.id).catch((e) => this.logger.warn(`Feeder ${f.name}: ${e.message}`));
      }
    } catch (e: any) {
      this.logger.warn(`Feeder tick failed: ${e.message}`);
    } finally {
      this.feedersBusy = false;
    }
  }

  // ---------------------------------------------------------------- MISP feeders (CRUD + run)

  async listFeeders(user: AuthUser) {
    return this.prisma.alertFeeder.findMany({
      where: { organisationId: user.organisationId, config: { path: ['type'], equals: 'misp' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createFeeder(user: AuthUser, body: any) {
    const config = await this.feederConfig(user, body, {});
    return this.prisma.alertFeeder.create({
      data: { organisationId: user.organisationId, name: String(body?.name || 'MISP feeder'), enabled: body?.enabled !== false, config, createdById: user.id },
    });
  }

  async updateFeeder(user: AuthUser, id: string, body: any) {
    const feeder = await this.getFeeder(user, id);
    const config = await this.feederConfig(user, { ...(feeder.config as any), ...body }, feeder.config as any);
    return this.prisma.alertFeeder.update({
      where: { id },
      data: { name: body?.name ?? undefined, enabled: body?.enabled ?? undefined, config },
    });
  }

  async deleteFeeder(user: AuthUser, id: string) {
    await this.getFeeder(user, id);
    await this.prisma.alertFeeder.delete({ where: { id } });
    return { ok: true };
  }

  async runFeederForUser(user: AuthUser, id: string) {
    await this.getFeeder(user, id);
    return this.runFeeder(id);
  }

  async runFeeder(id: string) {
    const feeder = await this.prisma.alertFeeder.findUnique({ where: { id } });
    if (!feeder) throw new NotFoundException('Feeder not found');
    const cfg: any = feeder.config || {};
    const startedAt = new Date();
    let lastResult: any;
    try {
      const server = await this.connectors.getById(cfg.connectorId);
      if (!server || server.type !== 'misp') throw new Error('MISP server not found');
      const result = await this.misp.syncEvents(
        server,
        { organisationId: feeder.organisationId, actorId: feeder.createdById },
        this.misp.parseOptions(cfg),
      );
      const { alerts, ...summary } = result;
      lastResult = { ok: true, ...summary };
      if (summary.created || summary.updated) this.logger.log(`Feeder ${feeder.name}: +${summary.created} new, ${summary.updated} updated alerts`);
    } catch (e: any) {
      lastResult = { ok: false, error: e.message };
    }
    const updated = await this.prisma.alertFeeder.update({
      where: { id },
      data: { config: { ...cfg, lastRunAt: startedAt.toISOString(), lastResult } },
    });
    return updated;
  }

  private async getFeeder(user: AuthUser, id: string) {
    const feeder = await this.prisma.alertFeeder.findFirst({ where: { id, organisationId: user.organisationId, config: { path: ['type'], equals: 'misp' } } });
    if (!feeder) throw new NotFoundException('Feeder not found');
    return feeder;
  }

  private async feederConfig(user: AuthUser, body: any, previous: any) {
    if (!body?.connectorId) throw new BadRequestException('connectorId is required');
    await this.connectors.get(user, body.connectorId, 'misp');
    const options = this.misp.parseOptions(body);
    return {
      ...previous,
      type: 'misp',
      connectorId: body.connectorId,
      intervalMinutes: Math.max(1, Number(body.intervalMinutes || previous.intervalMinutes || 15)),
      last: options.last,
      limit: options.limit,
      publishedOnly: options.publishedOnly,
      tags: options.tags || [],
    };
  }
}
