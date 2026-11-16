import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImapFeederService } from './imap-feeder.service';

/**
 * Runs IMAP feeders every 60s when their interval elapsed.
 * Disable with EMAIL_SCHEDULER=false.
 */
@Injectable()
export class EmailScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EmailScheduler');
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly feeders: ImapFeederService,
  ) {}

  onModuleInit() {
    if (process.env.EMAIL_SCHEDULER === 'false') return;
    this.timers.push(setInterval(() => this.tick(), 60000));
    setTimeout(() => this.tick(), 20000);
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.prisma.alertFeeder.findMany({
        where: { enabled: true, config: { path: ['type'], equals: 'imap' } },
      });
      for (const feeder of rows) {
        const cfg: any = feeder.config || {};
        const interval = Math.max(1, Number(cfg.intervalMinutes || 5)) * 60000;
        const lastRun = cfg.lastRunAt ? new Date(cfg.lastRunAt).getTime() : 0;
        if (Date.now() - lastRun < interval) continue;
        await this.feeders.runFeeder(feeder.id).catch((error) => this.logger.warn(`Feeder ${feeder.name}: ${error?.message || error}`));
      }
    } catch (error: any) {
      this.logger.warn(`IMAP feeder tick failed: ${error?.message || error}`);
    } finally {
      this.busy = false;
    }
  }
}
