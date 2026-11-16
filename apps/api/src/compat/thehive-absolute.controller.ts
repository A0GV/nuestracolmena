import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { AdminService } from '../admin/admin.service';
import { AlertsService } from '../alerts/alerts.service';
import { Connector, ConnectorsService } from '../integrations/connectors.service';
import { CortexService, ResponderTarget } from '../integrations/cortex.service';
import { PrismaService } from '../prisma/prisma.service';
import { mapAction, mapCase, mapCustomField, ms } from './thehive-mapper';

const FINAL_STATUSES = ['Success', 'Failure', 'Deleted'];

/** TheHive object type names used by the Cortex connector. */
function responderTarget(type: string): ResponderTarget | null {
  switch (type) {
    case 'case':
      return 'case';
    case 'case_task':
    case 'task':
      return 'task';
    case 'case_artifact':
    case 'observable':
      return 'observable';
    case 'alert':
      return 'alert';
    default:
      return null;
  }
}

@ApiTags('TheHive 5 compatibility (absolute routes)')
@ApiBearerAuth()
@Controller('api')
export class TheHiveAbsoluteController {
  constructor(
    private readonly admin: AdminService,
    private readonly alerts: AlertsService,
    private readonly connectors: ConnectorsService,
    private readonly cortex: CortexService,
    private readonly prisma: PrismaService,
  ) {}

  // The n8n TheHive 5 node calls /api/alert/:id/merge/:caseId (without /v1).
  @RequirePermissions('manageAlert/import')
  @Post('alert/:id/merge/:caseId')
  async mergeAlert(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('caseId') caseId: string) {
    return mapCase(await this.alerts.mergeIntoCase(user, id, caseId));
  }

  @Get('customField')
  async customFields(@CurrentUser() user: AuthUser) {
    return (await this.admin.customFields(user)).map(mapCustomField);
  }

  // ------------------------------------------------------------------ Cortex

  @Get('connector/cortex/analyzer/type/:dataType')
  async analyzers(@CurrentUser() user: AuthUser, @Param('dataType') dataType: string) {
    const { analyzers } = await this.cortex.listAnalyzers(user, dataType);
    return analyzers.map((analyzer) => ({
      id: analyzer.id,
      name: analyzer.name,
      version: analyzer.version,
      description: analyzer.description,
      dataTypeList: analyzer.dataTypeList || [],
      cortexIds: [analyzer.connectorId],
    }));
  }

  @RequirePermissions('manageAnalyse')
  @Post('connector/cortex/job')
  async runAnalyzer(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body?.analyzerId || !body?.artifactId) throw new BadRequestException('analyzerId and artifactId are required');
    const connector = await this.resolveConnector(user, body.cortexId);
    const { analyzers } = await this.cortex.listAnalyzers(user);
    const resolved = this.pickAnalyzer(analyzers, connector.id, body.analyzerId);
    const analyzerId = resolved?.id ?? body.analyzerId;
    const result = await this.cortex.runAnalyzers(user, body.artifactId, {
      analyzers: [{ connectorId: connector.id, analyzerId }],
    });
    const report = result.reports?.[0];
    if (!report) {
      const error = result.errors?.map((item: any) => `${item.analyzerId}: ${item.error}`).join('; ');
      throw new BadRequestException(error || 'Analyzer did not start');
    }
    return this.jobView(report, { analyzerId, connectorId: connector.id, artifactId: body.artifactId });
  }

  @Get('connector/cortex/job/:id')
  async getJob(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    let report = await this.prisma.observableReport.findFirst({
      where: { OR: [{ id }, { cortexJobId: id }], observable: { organisationId: user.organisationId } },
    });
    if (!report) throw new NotFoundException('Job not found');
    if (!FINAL_STATUSES.includes(report.status)) {
      await this.cortex.refreshReport(report.id).catch(() => undefined);
      report = await this.prisma.observableReport.findUnique({ where: { id: report.id } });
    }
    return this.jobView(report);
  }

  @Get('connector/cortex/responder/:type/:id')
  async responders(@CurrentUser() user: AuthUser, @Param('type') type: string) {
    const target = responderTarget(type);
    if (!target) return [];
    const { responders } = await this.cortex.listResponders(user, target);
    return responders.map((responder) => ({
      id: responder.id,
      name: responder.name,
      version: responder.version,
      description: responder.description,
      cortexIds: [responder.connectorId],
    }));
  }

  @RequirePermissions('manageAction')
  @Post('connector/cortex/action')
  async runAction(@CurrentUser() user: AuthUser, @Body() body: any) {
    const target = responderTarget(body?.objectType);
    if (!target) throw new BadRequestException(`Unsupported objectType: ${body?.objectType}`);
    if (!body?.responderId || !body?.objectId) throw new BadRequestException('responderId and objectId are required');
    const connector = await this.resolveConnector(user, body.cortexId);
    const { responders } = await this.cortex.listResponders(user, target);
    const resolved = this.pickResponder(responders, connector.id, body.responderId);
    const job = await this.cortex.runResponder(user, target, body.objectId, {
      connectorId: connector.id,
      responderId: resolved?.id ?? body.responderId,
      responderName: resolved?.name ?? body.responderName,
    });
    return mapAction(job);
  }

  // ------------------------------------------------------------------ helpers

  private pickAnalyzer(analyzers: any[], connectorId: string, value: any) {
    const candidates = analyzers.filter((analyzer) => analyzer.connectorId === connectorId);
    const wanted = String(value);
    return (
      candidates.find((analyzer) => analyzer.id === wanted) ||
      candidates.find((analyzer) => analyzer.name === wanted) ||
      candidates.find((analyzer) => String(analyzer.name).toLowerCase() === wanted.toLowerCase())
    );
  }

  private pickResponder(responders: any[], connectorId: string, value: any) {
    const candidates = responders.filter((responder) => responder.connectorId === connectorId);
    const wanted = String(value);
    return (
      candidates.find((responder) => responder.id === wanted) ||
      candidates.find((responder) => responder.name === wanted) ||
      candidates.find((responder) => String(responder.name).toLowerCase() === wanted.toLowerCase())
    );
  }

  private async resolveConnector(user: AuthUser, cortexId?: string): Promise<Connector> {
    if (cortexId) {
      try {
        return await this.connectors.get(user, cortexId, 'cortex');
      } catch {
        // TheHive accepts a stale cortexId by falling back to the first Cortex server.
      }
    }
    return this.connectors.first(user, 'cortex');
  }

  private jobView(report: any, overrides: { analyzerId?: string; connectorId?: string; artifactId?: string } = {}) {
    const out: any = {
      _id: report.id,
      id: report.id,
      _type: 'CortexJob',
      _createdAt: ms(report.createdAt),
      analyzerId: report.analyzerId ?? overrides.analyzerId,
      analyzerName: report.analyzer,
      status: report.status,
      artifactId: report.observableId ?? overrides.artifactId,
      cortexId: report.connectorId ?? overrides.connectorId,
      startDate: ms(report.createdAt),
      endDate: ms(report.updatedAt),
      taxonomies: report.taxonomies,
      artifacts: report.artifacts,
    };
    if (FINAL_STATUSES.includes(report.status)) {
      out.report = report.report;
      out.errorMessage = report.errorMessage;
    }
    return out;
  }
}
