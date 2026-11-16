import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { AutomationService } from './automation.service';
import { DeliveryService } from './delivery.service';
import { NotificationsEngine } from './notifications.engine';
import { FunctionsModule } from '../functions/functions.module';

@Module({
  imports: [FunctionsModule],
  controllers: [NotificationsController],
  providers: [DeliveryService, AutomationService, NotificationsEngine],
  exports: [AutomationService, DeliveryService],
})
export class NotificationsModule {}
