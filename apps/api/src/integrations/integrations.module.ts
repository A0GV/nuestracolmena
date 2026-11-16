import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { CortexService } from './cortex.service';
import { MispService } from './misp.service';
import { IntegrationsScheduler } from './integrations.scheduler';
import { IntegrationsController } from './integrations.controller';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [AttachmentsModule],
  controllers: [IntegrationsController],
  providers: [ConnectorsService, CortexService, MispService, IntegrationsScheduler],
  exports: [ConnectorsService, CortexService, MispService],
})
export class IntegrationsModule {}
