import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { CasesModule } from '../cases/cases.module';
import { QueryModule } from '../query/query.module';
import { FunctionInvokeController, FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';

@Module({
  imports: [AlertsModule, CasesModule, QueryModule],
  controllers: [FunctionsController, FunctionInvokeController],
  providers: [FunctionsService],
  exports: [FunctionsService],
})
export class FunctionsModule {}
