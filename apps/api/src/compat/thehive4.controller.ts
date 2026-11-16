import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../common/decorators/auth.decorators';
import { AlertsService } from '../alerts/alerts.service';
import { CasesService } from '../cases/cases.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueryService } from '../query/query.service';
import { CorrelationService } from '../correlation/correlation.service';
import {
  mapAlert4,
  mapArtifact4,
  mapAttachment4,
  mapCase4,
  mapCaseTemplate4,
  mapLog4,
  mapTask4,
  mapUser4,
  normaliseTheHive4AlertInput,
  normaliseTheHive4CaseInput,
  normaliseTheHive4CustomFields,
  normaliseTheHive4ObservableInput,
  normaliseTheHive4TaskInput,
} from './thehive-mapper';

@ApiTags('TheHive 4 compatibility')
@ApiBearerAuth()
@Controller('api')
export class TheHive4Controller {
  constructor(
    private readonly alerts: AlertsService,
    private readonly cases: CasesService,
    private readonly attachments: AttachmentsService,
    private readonly prisma: PrismaService,
    private readonly query: QueryService,
    private readonly correlation: CorrelationService,
  ) {}

  // ------------------------------------------------------------------ status / user

  @Public()
  @Get('status')
  status() {
    return {
      versions: {
        TheHive: '4.1-compatible (Nuestracolmena)',
        Nuestracolmena: '0.1.0',
      },
      config: {
        protectDownloadsWith: 'malware',
        authType: ['key', 'session'],
        capabilities: [],
      },
    };
  }

  @Get('user/current')
  currentUser(@CurrentUser() user: AuthUser) {
    return mapUser4({
      id: user.id,
      login: user.login,
      name: user.name,
      email: null,
      profile: user.profileName,
      organisation: user.organisationId,
      createdAt: new Date(),
    });
  }

  // ------------------------------------------------------------------ alerts

  @RequirePermissions('manageAlert/create')
  @Post('alert')
  async createAlert(@CurrentUser() user: AuthUser, @Body() body: any) {
    return mapAlert4(await this.alerts.create(user, normaliseTheHive4AlertInput(body || {})));
  }

  @Post('alert/_search')
  searchAlerts(@CurrentUser() user: AuthUser, @Body() body: any, @Query('range') range?: string, @Query('sort') sort?: string) {
    return this.legacySearch(user, 'listAlert', body, range, sort);
  }

  @Get('alert/:id')
  async getAlert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapAlert4(await this.alerts.get(user, id));
  }

  @RequirePermissions('manageAlert/update')
  @Patch('alert/:id')
  async updateAlert(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapAlert4(await this.alerts.update(user, id, normaliseTheHive4AlertInput(body || {})));
  }

  @RequirePermissions('manageAlert/delete')
  @Delete('alert/:id')
  removeAlert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alerts.remove(user, id);
  }

  @RequirePermissions('manageAlert/update')
  @Post('alert/:id/markAsRead')
  async markAsRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapAlert4(await this.alerts.mark(user, id, { read: true }));
  }

  @RequirePermissions('manageAlert/update')
  @Post('alert/:id/markAsUnread')
  async markAsUnread(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapAlert4(await this.alerts.mark(user, id, { read: false }));
  }

  @RequirePermissions('manageAlert/import')
  @Post('alert/:id/createCase')
  async alertToCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapCase4(await this.alerts.importToCase(user, id, normaliseTheHive4CaseInput(body || {})));
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageObservable')
  @Post('alert/:id/artifact')
  @UseInterceptors(FileInterceptor('attachment'))
  async alertArtifact(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @UploadedFile() file?: any,
  ) {
    const payload = this.parsePayload(body);
    if (file) {
      const result = await this.cases.createFileObservables(user, { alertId: id }, [file], normaliseTheHive4ObservableInput(payload));
      return mapArtifact4(result.files[0].observable);
    }
    return mapArtifact4(await this.alerts.createObservable(user, id, normaliseTheHive4ObservableInput(payload)));
  }

  // ------------------------------------------------------------------ cases

  @RequirePermissions('manageCase/create')
  @Post('case')
  async createCase(@CurrentUser() user: AuthUser, @Body() body: any) {
    return mapCase4(await this.cases.createCase(user, normaliseTheHive4CaseInput(body || {})));
  }

  @Post('case/_search')
  searchCases(@CurrentUser() user: AuthUser, @Body() body: any, @Query('range') range?: string, @Query('sort') sort?: string) {
    return this.legacySearch(user, 'listCase', body, range, sort);
  }

  @Get('case/:id')
  async getCase(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapCase4(await this.cases.getCase(user, id));
  }

  @RequirePermissions('manageCase/update')
  @Patch('case/:id')
  async updateCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    const status = body?.status;
    if (status === 'Deleted') {
      await this.cases.deleteCase(user, id, true);
      return { ok: true };
    }
    const current = await this.cases.getCase(user, id);
    if (status === 'Resolved') {
      const resolution = body?.resolutionStatus;
      const known = resolution
        ? await this.prisma.caseStatus.findFirst({ where: { organisationId: user.organisationId, value: resolution } })
        : null;
      await this.cases.closeCase(user, id, {
        status: known ? resolution : 'TruePositive',
        summary: body?.summary,
        customFields: body?.customFields !== undefined ? normaliseTheHive4CustomFields(body.customFields) : undefined,
      });
      return mapCase4(await this.cases.getCase(user, id));
    }
    if (status === 'Open' && (current.stage === 'Closed' || current.closedAt)) {
      await this.cases.reopenCase(user, id);
    }
    const { status: _status, resolutionStatus: _resolution, impactStatus: _impact, ...rest } = body || {};
    await this.cases.updateCase(user, id, normaliseTheHive4CaseInput(rest));
    return mapCase4(await this.cases.getCase(user, id));
  }

  @RequirePermissions('manageCase/delete')
  @Delete('case/:id')
  removeCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('force') force?: string) {
    const hard = force === undefined || !['0', 'false', 'no'].includes(String(force).toLowerCase());
    return this.cases.deleteCase(user, id, hard);
  }

  @Get('case/:id/links')
  async caseLinks(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const related = await this.correlation.relatedCases(user, id);
    if (!related.length) return [];
    const ids = related.map((entry) => entry.case.id);
    const rows = await this.prisma.case.findMany({
      where: { organisationId: user.organisationId, id: { in: ids } },
      include: {
        status: true,
        assignee: { select: { id: true, login: true, name: true } },
        createdBy: { select: { id: true, login: true, name: true } },
        observables: true,
        _count: { select: { tasks: true, observables: true, procedures: true, alerts: true } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return related.flatMap((entry) => {
      const item = byId.get(entry.case.id);
      if (!item) return [];
      const shared = new Set(entry.sharedObservables.map((observable) => `${observable.dataType}:${observable.data}`));
      return [{
        ...mapCase4(item),
        linkedWith: (item.observables || [])
          .filter((observable: any) => shared.has(`${observable.dataType}:${observable.data}`))
          .map(mapArtifact4),
      }];
    });
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageObservable')
  @Post('case/:id/artifact')
  @UseInterceptors(FileInterceptor('attachment'))
  async createCaseArtifact(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @UploadedFile() file?: any,
  ) {
    await this.cases.getCase(user, id);
    const payload = this.parsePayload(body);
    if (file) {
      const result = await this.cases.createFileObservables(user, { caseId: id }, [file], normaliseTheHive4ObservableInput(payload));
      return mapArtifact4(result.files[0].observable);
    }
    const observable = await this.cases.createObservable(user, {
      ...normaliseTheHive4ObservableInput(payload),
      caseId: id,
    });
    return mapArtifact4(observable);
  }

  @Post('case/artifact/_search')
  searchArtifacts(@CurrentUser() user: AuthUser, @Body() body: any, @Query('range') range?: string, @Query('sort') sort?: string) {
    return this.legacySearch(user, 'listObservable', body, range, sort);
  }

  @Get('case/artifact/:id')
  async getArtifact(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapArtifact4(await this.findArtifact(user, id));
  }

  @RequirePermissions('manageObservable')
  @Patch('case/artifact/:id')
  async updateArtifact(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    await this.findArtifact(user, id);
    await this.cases.updateObservable(user, id, normaliseTheHive4ObservableInput(body || {}));
    return mapArtifact4(await this.findArtifact(user, id));
  }

  @RequirePermissions('manageObservable')
  @Delete('case/artifact/:id')
  deleteArtifact(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteObservable(user, id);
  }

  @RequirePermissions('manageTask')
  @Post('case/:id/task')
  async createTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapTask4(await this.cases.createTask(user, id, normaliseTheHive4TaskInput(body || {})));
  }

  @Post('case/task/_search')
  searchTasks(@CurrentUser() user: AuthUser, @Body() body: any, @Query('range') range?: string, @Query('sort') sort?: string) {
    return this.legacySearch(user, 'listTask', body, range, sort);
  }

  @Get('case/task/:id')
  async getTask(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapTask4(await this.cases.getTask(user, id));
  }

  @RequirePermissions('manageTask')
  @Patch('case/task/:id')
  async updateTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    await this.cases.updateTask(user, id, normaliseTheHive4TaskInput(body || {}));
    return mapTask4(await this.cases.getTask(user, id));
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageTask')
  @Post('case/task/:id/log')
  @UseInterceptors(FileInterceptor('attachment'))
  async createLog(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @UploadedFile() file?: any,
  ) {
    const payload = this.parsePayload(body);
    if (!payload.message && file) payload.message = file.originalname;
    const log = await this.cases.createLog(user, id, payload);
    if (!file) return mapLog4(log);
    const attachment = await this.attachments.upload(user, file, { objectType: 'log', objectId: log.id });
    return mapLog4({ ...log, attachments: [attachment] });
  }

  @Get('case/task/:id/log')
  async taskLogs(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const task = await this.cases.getTask(user, id);
    const logs = await this.prisma.taskLog.findMany({
      where: { taskId: task.id, organisationId: user.organisationId },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
      orderBy: { date: 'asc' },
    });
    const attachments = await this.prisma.attachment.findMany({
      where: { organisationId: user.organisationId, objectType: 'log', objectId: { in: logs.map((log) => log.id) } },
    });
    const byLog = new Map<string, any[]>();
    for (const attachment of attachments) {
      byLog.set(attachment.objectId, [...(byLog.get(attachment.objectId) || []), attachment]);
    }
    return logs.map((log) => mapLog4({ ...log, attachments: byLog.get(log.id) || [] }));
  }

  @Post('case/task/log/_search')
  searchLogs(@CurrentUser() user: AuthUser, @Body() body: any, @Query('range') range?: string, @Query('sort') sort?: string) {
    return this.legacySearch(user, 'listLog', body, range, sort);
  }

  @Post('case/template/_search')
  searchTemplates(@CurrentUser() user: AuthUser, @Body() body: any, @Query('range') range?: string, @Query('sort') sort?: string) {
    return this.legacySearch(user, 'listCaseTemplate', body, range, sort);
  }

  @Get('case/template/:id')
  async getTemplate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const template = await this.prisma.caseTemplate.findFirst({
      where: { organisationId: user.organisationId, OR: [{ id }, { name: id }] },
      include: { tasks: { orderBy: { order: 'asc' } }, createdBy: { select: { id: true, login: true, name: true } } },
    });
    if (!template) throw new NotFoundException('Case template not found');
    return mapCaseTemplate4(template);
  }

  // ------------------------------------------------------------------ helpers

  private legacySearch(user: AuthUser, starter: string, body: any, range?: string, sort?: string) {
    const payload: any = { ...(body || {}) };
    if (payload.range === undefined && range !== undefined) payload.range = range;
    if (payload.sort === undefined && sort !== undefined) payload.sort = sort;
    return this.query.executeLegacy(user, starter, payload);
  }

  private parsePayload(body: any) {
    if (!body || typeof body !== 'object') return {};
    if (typeof body._json === 'string' && body._json.trim()) {
      try {
        return { ...body, ...JSON.parse(body._json) };
      } catch {
        throw new BadRequestException('Invalid _json payload');
      }
    }
    return { ...body };
  }

  private async findArtifact(user: AuthUser, id: string) {
    const observable = await this.prisma.observable.findFirst({
      where: { id, organisationId: user.organisationId },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
    if (!observable) throw new NotFoundException('Artifact not found');
    return observable;
  }
}
