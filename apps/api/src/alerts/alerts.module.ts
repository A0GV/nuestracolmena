import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { CasesModule } from '../cases/cases.module';
import { CorrelationModule } from '../correlation/correlation.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [CasesModule, CorrelationModule, AttachmentsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
