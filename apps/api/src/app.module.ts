import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { OrgsModule } from './orgs/orgs.module';
import { CasesModule } from './cases/cases.module';
import { AlertsModule } from './alerts/alerts.module';
import { AdminModule } from './admin/admin.module';
import { QueryModule } from './query/query.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { CompatModule } from './compat/compat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FunctionsModule } from './functions/functions.module';
import { SlaModule } from './sla/sla.module';
import { CorrelationModule } from './correlation/correlation.module';
import { MitreModule } from './mitre/mitre.module';
import { EmailModule } from './email/email.module';
import { AuthGuard } from './common/guards/auth.guard';
import { HealthController } from './health.controller';
import { StreamController } from './events/stream.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    AuthModule,
    OrgsModule,
    CasesModule,
    AlertsModule,
    AdminModule,
    QueryModule,
    AttachmentsModule,
    IntegrationsModule,
    CompatModule,
    NotificationsModule,
    FunctionsModule,
    SlaModule,
    CorrelationModule,
    MitreModule,
    EmailModule,
  ],
  controllers: [HealthController, StreamController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
