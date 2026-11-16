import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SlaService } from './sla.service';

@Injectable()
export class SlaScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SlaScheduler');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private backfilled = false;

  constructor(private readonly sla: SlaService) {}

  onModuleInit() {
    if (!this.backfilled) {
      this.backfilled = true;
      void this.sla.backfillAcknowledgements();
    }
    if (process.env.SLA_SCHEDULER === 'false') return;
    this.timer = setInterval(() => this.tick(), 60000);
    this.timer.unref?.();
    const initial = setTimeout(() => this.tick(), 15000);
    initial.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.sla.runPass();
      if (result.emitted) this.logger.log(`Emitted ${result.emitted} SLA event(s)`);
    } catch (e: any) {
      this.logger.warn(`SLA pass failed: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
