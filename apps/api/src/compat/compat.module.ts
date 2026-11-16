import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { CasesModule } from '../cases/cases.module';
import { AdminModule } from '../admin/admin.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { QueryModule } from '../query/query.module';
import { CorrelationModule } from '../correlation/correlation.module';
import { TheHiveController } from './thehive.controller';
import { TheHiveAbsoluteController } from './thehive-absolute.controller';
import { TheHive4Controller } from './thehive4.controller';

@Module({
  imports: [AlertsModule, CasesModule, AdminModule, AttachmentsModule, IntegrationsModule, QueryModule, CorrelationModule],
  controllers: [TheHiveController, TheHiveAbsoluteController, TheHive4Controller],
})
export class CompatModule {}
