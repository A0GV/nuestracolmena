import { Module } from '@nestjs/common';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { CorrelationModule } from '../correlation/correlation.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [CorrelationModule, AttachmentsModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
