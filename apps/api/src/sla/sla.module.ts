import { Global, Module } from '@nestjs/common';
import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';
import { SlaScheduler } from './sla.scheduler';

@Global()
@Module({
  controllers: [SlaController],
  providers: [SlaService, SlaScheduler],
  exports: [SlaService],
})
export class SlaModule {}
