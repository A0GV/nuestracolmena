import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { EmailParserService } from './email-parser.service';
import { EmailIntakeService } from './email-intake.service';
import { ImapFeederService } from './imap-feeder.service';
import { EmailScheduler } from './email.scheduler';
import { EmailController } from './email.controller';
import { EmailImportController } from './email-import.controller';

@Module({
  imports: [AlertsModule],
  controllers: [EmailController, EmailImportController],
  providers: [EmailParserService, EmailIntakeService, ImapFeederService, EmailScheduler],
  exports: [EmailIntakeService, ImapFeederService],
})
export class EmailModule {}
