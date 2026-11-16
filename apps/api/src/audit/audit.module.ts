import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsModule, EventsService, normaliseObjectType } from '../events/events.module';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async log(params: {
    organisationId?: string | null;
    actorId?: string | null;
    action: string;
    objectType: string;
    objectId?: string | null;
    details?: any;
    ip?: string | null;
    /** Root object (owning case or alert) used by the notification engine. */
    rootId?: string | null;
    rootType?: string | null;
    /** Raw snapshot to include in the emitted event (needed for deletions). */
    object?: any;
    context?: any;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          organisationId: params.organisationId ?? null,
          actorId: params.actorId ?? null,
          action: params.action,
          objectType: params.objectType,
          objectId: params.objectId ?? null,
          details: params.details ?? {},
          ip: params.ip ?? null,
        },
      });
    } catch {
      // Audit must never break the main operation.
    }

    try {
      const details = params.details ?? {};
      const objectType = normaliseObjectType(params.objectType);
      const rootType = params.rootType ?? details.rootType ?? (objectType === 'Case' || objectType === 'Alert' ? objectType : null);
      const rootId =
        params.rootId ??
        details.rootId ??
        details.caseId ??
        details.alertId ??
        (objectType === 'Case' || objectType === 'Alert' ? params.objectId ?? null : null);
      let actorLogin: string | null = null;
      if (params.actorId) {
        const actor = await this.prisma.user.findUnique({ where: { id: params.actorId }, select: { login: true } }).catch(() => null);
        actorLogin = actor?.login ?? null;
      }
      this.events.emit({
        action: params.action,
        objectType,
        objectId: params.objectId ?? null,
        rootId: rootId ?? null,
        rootType,
        organisationId: params.organisationId ?? null,
        actorId: params.actorId ?? null,
        actorLogin,
        details,
        date: new Date(),
        object: params.object,
        context: params.context,
      });
    } catch {
      // Event emission must never break the main operation.
    }
  }

  list(organisationId: string, limit = 100) {
    return this.prisma.auditLog.findMany({
      where: { organisationId },
      include: { actor: { select: { id: true, login: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

@Global()
@Module({
  imports: [EventsModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
