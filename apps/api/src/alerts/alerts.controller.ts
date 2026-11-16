import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { AlertsService } from './alerts.service';
import { CorrelationService } from '../correlation/correlation.service';

@ApiTags('Alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly correlation: CorrelationService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.alerts.list(user, query);
  }

  @RequirePermissions('manageAlert/create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.alerts.create(user, body);
  }

  @RequirePermissions('manageAlert/update')
  @Patch('_bulk')
  bulk(@CurrentUser() user: AuthUser, @Body() body: { ids: string[]; data: any }) {
    return this.alerts.bulk(user, body.ids, body.data);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alerts.get(user, id);
  }

  @Get(':id/similar')
  similar(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.correlation.similarForAlert(user, id);
  }

  @RequirePermissions('manageAlert/update')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.alerts.update(user, id, body);
  }

  @RequirePermissions('manageAlert/delete')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alerts.remove(user, id);
  }

  @RequirePermissions('manageAlert/update')
  @Post(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { read?: boolean; follow?: boolean }) {
    return this.alerts.mark(user, id, body);
  }

  @RequirePermissions('manageAlert/import')
  @Post(':id/case')
  importToCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.alerts.importToCase(user, id, body);
  }

  @RequirePermissions('manageAlert/import')
  @Post(':id/merge/:caseId')
  mergeIntoCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('caseId') caseId: string) {
    return this.alerts.mergeIntoCase(user, id, caseId);
  }

  @RequirePermissions('manageObservable')
  @Post(':id/observables')
  addObservable(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.alerts.createObservable(user, id, body);
  }

  @ApiConsumes('multipart/form-data')
  @RequirePermissions('manageObservable')
  @Post(':id/observables/file')
  @UseInterceptors(FilesInterceptor('file'))
  addFileObservables(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFiles() files: any[], @Body() body: any) {
    return this.alerts.createFileObservables(user, id, files, body || {});
  }

  @RequirePermissions('manageProcedure')
  @Post(':id/procedures')
  addProcedure(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.alerts.createProcedure(user, id, body);
  }
}
