import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import archiver from 'archiver';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { CasesService } from './cases.service';
import { CorrelationService } from '../correlation/correlation.service';
import archiverZipEncrypted from 'archiver-zip-encrypted';

try {
  archiver.registerFormat('zip-encrypted', archiverZipEncrypted as any);
} catch {
  // Format already registered (hot reload).
}

@ApiTags('Cases')
@ApiBearerAuth()
@Controller()
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly correlation: CorrelationService,
  ) {}

  @Get('stats')
  stats(@CurrentUser() user: AuthUser) {
    return this.cases.stats(user);
  }

  @Get('cases')
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.cases.listCases(user, query);
  }

  @RequirePermissions('manageCase/create')
  @Post('cases')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.cases.createCase(user, body);
  }

  @RequirePermissions('manageCase/update')
  @Patch('cases/_bulk')
  bulk(@CurrentUser() user: AuthUser, @Body() body: { ids: string[]; data: any }) {
    return this.cases.bulkUpdate(user, body.ids, body.data);
  }

  @Get('cases/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.getCase(user, id);
  }

  @Get('cases/:id/related')
  related(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.correlation.relatedCases(user, id);
  }

  @RequirePermissions('manageCase/update')
  @Patch('cases/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.updateCase(user, id, body);
  }

  @RequirePermissions('manageCase/delete')
  @Delete('cases/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('force') force: string) {
    return this.cases.deleteCase(user, id, force === 'true');
  }

  @RequirePermissions('manageCase/update')
  @Post('cases/:id/close')
  close(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.closeCase(user, id, body);
  }

  @RequirePermissions('manageCase/reopen')
  @Post('cases/:id/reopen')
  reopen(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.reopenCase(user, id);
  }

  @RequirePermissions('manageCase/merge')
  @Post('cases/:id/merge')
  merge(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { ids: string[] }) {
    return this.cases.mergeCases(user, [id, ...(body.ids || [])]);
  }



  @Get('cases/:id/shares')
  shares(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.listShares(user, id);
  }

  @RequirePermissions('manageShare')
  @Post('cases/:id/shares')
  addShare(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.addShare(user, id, body);
  }

  @RequirePermissions('manageShare')
  @Delete('cases/:id/shares/:shareId')
  removeShare(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('shareId') shareId: string) {
    return this.cases.removeShare(user, id, shareId);
  }

  @Get('cases/:id/reports')
  reports(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.listReports(user, id);
  }

  @RequirePermissions('manageCaseReport')
  @Post('cases/:id/report')
  generateReport(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.generateReport(user, id);
  }

  @Get('cases/:id/timeline')
  timeline(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.timeline(user, id);
  }

  @Get('cases/:id/tasks')
  tasksByCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() query: any) {
    return this.cases.listTasks(user, { ...query, caseId: id });
  }

  @RequirePermissions('manageTask')
  @Post('cases/:id/tasks')
  createTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.createTask(user, id, body);
  }

  @RequirePermissions('manageObservable')
  @Post('cases/:id/observables')
  createObservable(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.createObservable(user, { ...body, caseId: id });
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageObservable')
  @Post('cases/:id/observables/file')
  @UseInterceptors(FilesInterceptor('file'))
  addFileObservables(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFiles() files: any[], @Body() body: any) {
    return this.cases.createFileObservables(user, { caseId: id }, files, body || {});
  }

  @RequirePermissions('manageObservable')
  @Post('cases/:id/observables/_merge')
  mergeObservables(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.mergeObservables(user, id);
  }

  @RequirePermissions('manageProcedure')
  @Post('cases/:id/procedures')
  createProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.createProcedure(user, { ...body, caseId: id });
  }

  @Get('cases/:id/comments')
  comments(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.listComments(user, 'case', id);
  }

  @RequirePermissions('manageComment')
  @Post('cases/:id/comments')
  createComment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.createComment(user, { ...body, objectType: 'case', objectId: id });
  }

  @Get('tasks')
  listTasks(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.cases.listTasks(user, query);
  }

  @Get('tasks/:id')
  getTask(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.getTask(user, id);
  }

  @RequirePermissions('manageTask')
  @Patch('tasks/_bulk')
  bulkTasks(@CurrentUser() user: AuthUser, @Body() body: { ids: string[]; data: any }) {
    return this.cases.bulkTasks(user, body.ids, body.data);
  }

  @RequirePermissions('manageTask')
  @Patch('tasks/:id')
  updateTask(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.updateTask(user, id, body);
  }

  @RequirePermissions('manageTask')
  @Delete('tasks/:id')
  deleteTask(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteTask(user, id);
  }

  @Get('tasks/:id/actionRequired')
  actionRequired(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.taskActionRequired(user, id);
  }

  @RequirePermissions('manageTask')
  @Post('tasks/:id/actionRequired')
  setActionRequired(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { required: boolean }) {
    return this.cases.setTaskAction(user, id, !!body.required);
  }

  @RequirePermissions('manageTask')
  @Post('tasks/:id/logs')
  createLog(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.createLog(user, id, body);
  }

  @RequirePermissions('manageTask')
  @Patch('logs/:id')
  updateLog(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.updateLog(user, id, body);
  }

  @RequirePermissions('manageTask')
  @Delete('logs/:id')
  deleteLog(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteLog(user, id);
  }

  @Get('observables')
  listObservables(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.cases.listObservables(user, query);
  }

  @RequirePermissions('manageObservable')
  @Post('observables')
  createObservableRoot(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.cases.createObservable(user, body);
  }

  @RequirePermissions('manageObservable')
  @Post('observables/_bulk')
  createObservablesBulk(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.cases.createObservablesBulk(user, body);
  }

  @RequirePermissions('manageObservable')
  @Patch('observables/_bulk')
  bulkObservables(@CurrentUser() user: AuthUser, @Body() body: { ids: string[]; data: any }) {
    return this.cases.bulkObservables(user, body.ids, body.data);
  }

  @RequirePermissions('manageObservable')
  @Post('observables/_merge')
  mergeObservablesRoot(@CurrentUser() user: AuthUser, @Body() body: { caseId: string }) {
    return this.cases.mergeObservables(user, body.caseId);
  }

  @RequirePermissions('manageObservable')
  @Patch('observables/:id')
  updateObservable(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.updateObservable(user, id, body);
  }

  @RequirePermissions('manageObservable')
  @Delete('observables/:id')
  deleteObservable(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteObservable(user, id);
  }

  @Get('observables/:id/download')
  async downloadObservable(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('zip') zip: string,
    @Res() res: Response,
  ) {
    const { attachment, path } = await this.cases.getObservableDownload(user, id);
    if (zip !== '1' && zip !== 'true') {
      res.download(path, attachment.filename);
      return;
    }
    const filename = `${attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const archive: any = (archiver as any).create('zip-encrypted', { zlib: { level: 8 }, encryptionMethod: 'zip20', password: 'malware' });
    archive.on('error', (error: any) => res.destroy(error));
    archive.pipe(res);
    archive.file(path, { name: attachment.filename });
    await archive.finalize();
  }

  @Get('observables/:id/sightings')
  sightings(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.correlation.sightings(user, id);
  }

  @RequirePermissions('manageAnalyse')
  @Post('observables/:id/reports')
  addReport(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.addObservableReport(user, id, body);
  }

  @Get('procedures/stats')
  procedureStats(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.cases.procedureStats(user, query);
  }

  @Get('procedures')
  listProcedures(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.cases.listProcedures(user, query);
  }

  @RequirePermissions('manageProcedure')
  @Post('procedures')
  createProcedureRoot(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.cases.createProcedure(user, body);
  }

  @RequirePermissions('manageProcedure')
  @Patch('procedures/:id')
  updateProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cases.updateProcedure(user, id, body);
  }

  @RequirePermissions('manageProcedure')
  @Delete('procedures/:id')
  deleteProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteProcedure(user, id);
  }

  @Get('comments')
  listComments(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.cases.listComments(user, query.objectType || 'case', query.objectId);
  }

  @RequirePermissions('manageComment')
  @Post('comments')
  createCommentRoot(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.cases.createComment(user, body);
  }

  @RequirePermissions('manageComment')
  @Delete('comments/:id')
  deleteComment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.deleteComment(user, id);
  }
}
