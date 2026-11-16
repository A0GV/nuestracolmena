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
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { CasesService } from '../cases/cases.service';
import { AdminService } from '../admin/admin.service';
import { AttachmentsService } from '../attachments/attachments.service';
import {
  mapAlert,
  mapAttachment,
  mapCase,
  mapCaseTemplate,
  mapComment,
  mapLog,
  mapObservable,
  mapPage,
  mapProcedure,
  mapTask,
  mapUser,
  normaliseAlertInput,
  normaliseCaseInput,
  normaliseCommentInput,
  normaliseCustomFields,
  normaliseObservableInput,
  normaliseTaskInput,
} from './thehive-mapper';

const ids = (body: any): string[] => {
  if (!Array.isArray(body?.ids) || body.ids.length === 0) throw new BadRequestException('ids array is required');
  return body.ids.map(String);
};

const withoutIds = (body: any): any => {
  const { ids: _ids, ...rest } = body || {};
  return rest;
};

@ApiTags('TheHive 5 compatibility')
@ApiBearerAuth()
@Controller()
export class TheHiveController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly cases: CasesService,
    private readonly admin: AdminService,
    private readonly attachments: AttachmentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('user/current')
  currentUser(@CurrentUser() user: AuthUser) {
    return mapUser({
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
    return mapAlert(await this.alerts.create(user, normaliseAlertInput(body || {})));
  }

  @RequirePermissions('manageAlert/update')
  @Patch('alert/_bulk')
  async bulkAlerts(@CurrentUser() user: AuthUser, @Body() body: any) {
    const result = await this.alerts.bulk(user, ids(body), withoutIds(normaliseAlertInput(body || {})));
    return { success: true, updated: result.count };
  }

  @Get('alert/:id')
  async getAlert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapAlert(await this.alerts.get(user, id));
  }

  @RequirePermissions('manageAlert/update')
  @Patch('alert/:id')
  async updateAlert(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapAlert(await this.alerts.update(user, id, normaliseAlertInput(body || {})));
  }

  @RequirePermissions('manageAlert/delete')
  @Delete('alert/:id')
  removeAlert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alerts.remove(user, id);
  }

  @RequirePermissions('manageAlert/import')
  @Post('alert/:id/case')
  async alertToCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapCase(await this.alerts.importToCase(user, id, normaliseCaseInput(body || {})));
  }

  @RequirePermissions('manageAlert/import')
  @Post('alert/:id/merge/:caseId')
  async mergeAlert(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('caseId') caseId: string) {
    return mapCase(await this.alerts.mergeIntoCase(user, id, caseId));
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageObservable')
  @Post('alert/:id/observable')
  @UseInterceptors(FilesInterceptor('attachment'))
  async alertObservable(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @UploadedFiles() files: any[],
  ) {
    const payload = this.parsePayload(body);
    if (files?.length) {
      const result = await this.cases.createFileObservables(user, { alertId: id }, files, normaliseObservableInput(payload));
      return mapObservable(result.files[0].observable);
    }
    return mapObservable(await this.alerts.createObservable(user, id, normaliseObservableInput(payload)));
  }

  @RequirePermissions('manageComment')
  @Post('alert/:id/comment')
  async alertComment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapComment(await this.cases.createComment(user, { ...normaliseCommentInput(body || {}), objectType: 'alert', objectId: id }));
  }

  // ------------------------------------------------------------------ cases

  @RequirePermissions('manageCase/create')
  @Post('case')
  async createCase(@CurrentUser() user: AuthUser, @Body() body: any) {
    return mapCase(await this.cases.createCase(user, normaliseCaseInput(body || {})));
  }

  @RequirePermissions('manageCase/update')
  @Patch('case/_bulk')
  async bulkCases(@CurrentUser() user: AuthUser, @Body() body: any) {
    const result = await this.cases.bulkUpdate(user, ids(body), withoutIds(normaliseCaseInput(body || {})));
    return { success: true, updated: result.count };
  }

  @Get('case/:id')
  async getCase(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return mapCase(await this.cases.getCase(user, id));
  }

  @RequirePermissions('manageCase/update')
  @Patch('case/:id')
  async updateCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    await this.cases.updateCase(user, id, normaliseCaseInput(body || {}));
    return mapCase(await this.cases.getCase(user, id));
  }

  @RequirePermissions('manageCase/delete')
  @Delete('case/:id')
  removeCase(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteCase(user, id, true);
  }

  @RequirePermissions('manageTask')
  @Post('case/:id/task')
  async createTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapTask(await this.cases.createTask(user, id, normaliseTaskInput(body || {})));
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageObservable')
  @Post('case/:id/observable')
  @UseInterceptors(FilesInterceptor('attachment'))
  async createObservable(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @UploadedFiles() files: any[],
  ) {
    const payload = this.parsePayload(body);
    if (files?.length) {
      const result = await this.cases.createFileObservables(user, { caseId: id }, files, normaliseObservableInput(payload));
      return mapObservable(result.files[0].observable);
    }
    return mapObservable(await this.cases.createObservable(user, { ...normaliseObservableInput(payload), caseId: id }));
  }

  @RequirePermissions('manageComment')
  @Post('case/:id/comment')
  async createComment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapComment(await this.cases.createComment(user, { ...normaliseCommentInput(body || {}), objectType: 'case', objectId: id }));
  }

  @RequirePermissions('manageProcedure')
  @Post('case/:id/procedure')
  async createCaseProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapProcedure(await this.cases.createProcedure(user, { ...(body || {}), caseId: id }));
  }

  @RequirePermissions('manageProcedure')
  @Post('alert/:id/procedure')
  async createAlertProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapProcedure(await this.alerts.createProcedure(user, id, body || {}));
  }

  @RequirePermissions('manageProcedure')
  @Patch('procedure/:id')
  async updateProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapProcedure(await this.cases.updateProcedure(user, id, body || {}));
  }

  @RequirePermissions('manageProcedure')
  @Delete('procedure/:id')
  removeProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteProcedure(user, id);
  }

  @Get('case/:id/timeline')
  timeline(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.thehiveTimeline(user, id);
  }

  @ApiConsumes('multipart/form-data')
  @Post('case/:id/attachments')
  @UseInterceptors(FilesInterceptor('attachments'))
  async addCaseAttachments(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFiles() files: any[]) {
    await this.cases.getCase(user, id);
    return this.uploadFiles(user, files, 'case', id);
  }

  @Get('case/:id/attachment/:attachmentId/download')
  async downloadCaseAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const { attachment, path } = await this.attachments.getForDownload(attachmentId);
    this.assertAttachment(user, attachment, 'case', id);
    res.download(path, attachment.filename);
  }

  @Delete('case/:id/attachment/:attachmentId')
  async deleteCaseAttachment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    const { attachment } = await this.attachments.getForDownload(attachmentId);
    this.assertAttachment(user, attachment, 'case', id);
    return this.attachments.remove(attachmentId);
  }

  @RequirePermissions('manageKnowledgeBase')
  @Post('case/:id/page')
  async createCasePage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapPage(await this.admin.createCasePage(user, id, body || {}));
  }

  @RequirePermissions('manageKnowledgeBase')
  @Patch('case/:id/page/:pageId')
  async updateCasePage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('pageId') pageId: string, @Body() body: any) {
    return mapPage(await this.admin.updateCasePage(user, id, pageId, body || {}));
  }

  @RequirePermissions('manageKnowledgeBase')
  @Delete('case/:id/page/:pageId')
  deleteCasePage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('pageId') pageId: string) {
    return this.admin.deleteCasePage(user, id, pageId);
  }

  // ------------------------------------------------------------------ tasks

  @RequirePermissions('manageTask')
  @Patch('task/_bulk')
  async bulkTasks(@CurrentUser() user: AuthUser, @Body() body: any) {
    const result = await this.cases.bulkTasks(user, ids(body), withoutIds(body || {}));
    return { success: true, updated: result.count };
  }

  @RequirePermissions('manageTask')
  @Patch('task/:id')
  async updateTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    await this.cases.updateTask(user, id, normaliseTaskInput(body || {}));
    return mapTask(await this.cases.getTask(user, id));
  }

  @RequirePermissions('manageTask')
  @Delete('task/:id')
  deleteTask(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteTask(user, id);
  }

  @RequirePermissions('manageTask')
  @Post('task/:id/log')
  async createLog(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapLog(await this.cases.createLog(user, id, body || {}));
  }

  // ------------------------------------------------------------------ logs

  @RequirePermissions('manageTask')
  @Delete('log/:id')
  deleteLog(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteLog(user, id);
  }

  @ApiConsumes('multipart/form-data')
  @Post('log/:id/attachments')
  @UseInterceptors(FilesInterceptor('attachments'))
  async addLogAttachments(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFiles() files: any[]) {
    const log = await this.prismaFindLog(user, id);
    return this.uploadFiles(user, files, 'log', log.id);
  }

  @Delete('log/:id/attachments/:attachmentId')
  async deleteLogAttachment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    const { attachment } = await this.attachments.getForDownload(attachmentId);
    this.assertAttachment(user, attachment, 'log', id);
    return this.attachments.remove(attachmentId);
  }

  // ------------------------------------------------------------------ observables

  @RequirePermissions('manageObservable')
  @Patch('observable/_bulk')
  async bulkObservables(@CurrentUser() user: AuthUser, @Body() body: any) {
    const result = await this.cases.bulkObservables(user, ids(body), withoutIds(normaliseObservableInput(body || {})));
    return { success: true, updated: result.count };
  }

  @RequirePermissions('manageObservable')
  @Patch('observable/:id')
  async updateObservable(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapObservable(await this.cases.updateObservable(user, id, normaliseObservableInput(body || {})));
  }

  @RequirePermissions('manageObservable')
  @Delete('observable/:id')
  deleteObservable(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteObservable(user, id);
  }

  // ------------------------------------------------------------------ comments

  @RequirePermissions('manageComment')
  @Patch('comment/:id')
  async updateComment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapComment(await this.cases.updateComment(user, id, normaliseCommentInput(body || {})));
  }

  @RequirePermissions('manageComment')
  @Delete('comment/:id')
  deleteComment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteComment(user, id);
  }

  // ------------------------------------------------------------------ knowledge base

  @RequirePermissions('manageKnowledgeBase')
  @Post('page')
  async createPage(@CurrentUser() user: AuthUser, @Body() body: any) {
    return mapPage(await this.admin.createPage(user, body || {}));
  }

  @RequirePermissions('manageKnowledgeBase')
  @Patch('page/:id')
  async updatePage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return mapPage(await this.admin.updatePage(user, id, body || {}));
  }

  @RequirePermissions('manageKnowledgeBase')
  @Delete('page/:id')
  deletePage(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.deletePage(user, id);
  }

  // ------------------------------------------------------------------ case templates

  @RequirePermissions('manageCaseTemplate')
  @Post('caseTemplate')
  async createCaseTemplate(@CurrentUser() user: AuthUser, @Body() body: any) {
    const data = { ...(body || {}) };
    if (data.customFields !== undefined) data.customFields = normaliseCustomFields(data.customFields);
    return mapCaseTemplate(await this.admin.createTemplate(user, data));
  }

  // ------------------------------------------------------------------ helpers

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

  private async uploadFiles(user: AuthUser, files: any[], objectType: string, objectId: string) {
    if (!Array.isArray(files) || files.length === 0) throw new BadRequestException('attachments are required');
    const created = [];
    for (const file of files) created.push(await this.attachments.upload(user, file, { objectType, objectId }));
    return created.map(mapAttachment);
  }

  private assertAttachment(user: AuthUser, attachment: any, objectType: string, objectId: string) {
    if (attachment.organisationId !== user.organisationId || attachment.objectType !== objectType || attachment.objectId !== objectId) {
      throw new NotFoundException('Attachment not found');
    }
  }

  private async prismaFindLog(user: AuthUser, id: string) {
    const log = await this.prisma.taskLog.findFirst({ where: { id, organisationId: user.organisationId } });
    if (!log) throw new NotFoundException('Log not found');
    return log;
  }
}
