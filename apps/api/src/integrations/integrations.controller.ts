import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { ConnectorsService } from './connectors.service';
import { CortexService, ResponderTarget } from './cortex.service';
import { MispService } from './misp.service';
import { IntegrationsScheduler } from './integrations.scheduler';

const TARGETS: ResponderTarget[] = ['case', 'task', 'observable', 'alert'];
const target = (t: string): ResponderTarget => {
  if (!TARGETS.includes(t as ResponderTarget)) throw new BadRequestException(`target must be one of ${TARGETS.join(', ')}`);
  return t as ResponderTarget;
};

@ApiTags('Integrations (Cortex / MISP)')
@ApiBearerAuth()
@Controller()
export class IntegrationsController {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly cortex: CortexService,
    private readonly misp: MispService,
    private readonly scheduler: IntegrationsScheduler,
  ) {}

  // --------------------------------------------------------------- connectors

  @Get('connectors')
  async list(@CurrentUser() user: AuthUser, @Query('type') type?: string) {
    const rows = await this.connectors.list(user, type === 'cortex' || type === 'misp' ? type : undefined);
    return rows.map((c) => this.connectors.publicView(c));
  }

  @Get('connectors/status')
  async status(@CurrentUser() user: AuthUser) {
    const rows = await this.connectors.list(user);
    return Promise.all(rows.map(async (c) => ({ ...this.connectors.publicView(c), status: await this.connectors.test(c) })));
  }

  @RequirePermissions('manageConfig')
  @Post('connectors')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.connectors.create(user, body);
  }

  @RequirePermissions('manageConfig')
  @Patch('connectors/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.connectors.update(user, id, body);
  }

  @RequirePermissions('manageConfig')
  @Delete('connectors/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.connectors.remove(user, id);
  }

  @Post('connectors/:id/test')
  async test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.connectors.test(await this.connectors.get(user, id));
  }

  // --------------------------------------------------------------- Cortex analyzers

  @Get('cortex/analyzers')
  analyzers(@CurrentUser() user: AuthUser, @Query('dataType') dataType?: string) {
    return this.cortex.listAnalyzers(user, dataType);
  }

  @RequirePermissions('manageAnalyse')
  @Post('observables/:id/analyze')
  analyze(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.cortex.runAnalyzers(user, id, body);
  }

  @Get('observables/:id/reports')
  reports(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cortex.listReports(user, id);
  }

  @Get('observables/:id/reports/:reportId')
  report(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('reportId') reportId: string) {
    return this.cortex.getReport(user, id, reportId);
  }

  @RequirePermissions('manageObservable')
  @Post('observables/:id/reports/:reportId/artifacts')
  importArtifacts(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('reportId') reportId: string, @Body() body: any) {
    return this.cortex.importArtifacts(user, id, reportId, body);
  }

  // --------------------------------------------------------------- Cortex responders

  @Get('cortex/responders/:target')
  responders(@CurrentUser() user: AuthUser, @Param('target') t: string) {
    return this.cortex.listResponders(user, target(t));
  }

  @RequirePermissions('manageAction')
  @Post('cortex/responders/:target/:objectId')
  runResponder(@CurrentUser() user: AuthUser, @Param('target') t: string, @Param('objectId') objectId: string, @Body() body: any) {
    return this.cortex.runResponder(user, target(t), objectId, body);
  }

  @Get('cortex/actions/:target/:objectId')
  actions(@CurrentUser() user: AuthUser, @Param('target') t: string, @Param('objectId') objectId: string) {
    return this.cortex.listActions(user, target(t), objectId);
  }

  // --------------------------------------------------------------- MISP

  @RequirePermissions('manageAlert/create')
  @Post('misp/sync')
  sync(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.misp.syncForUser(user, body);
  }

  @RequirePermissions('manageShare')
  @Post('cases/:id/misp-export')
  exportCase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.misp.exportCase(user, id, body);
  }

  @Post('observables/:id/misp-search')
  search(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.misp.searchObservable(user, id, body);
  }

  @RequirePermissions('manageShare')
  @Delete('misp/events/:eventId')
  deleteEvent(@CurrentUser() user: AuthUser, @Param('eventId') eventId: string, @Body() body: any) {
    return this.misp.deleteEvent(user, eventId, body || {});
  }

  @Get('misp/feeders')
  feeders(@CurrentUser() user: AuthUser) {
    return this.scheduler.listFeeders(user);
  }

  @RequirePermissions('manageConfig')
  @Post('misp/feeders')
  createFeeder(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.scheduler.createFeeder(user, body);
  }

  @RequirePermissions('manageConfig')
  @Patch('misp/feeders/:id')
  updateFeeder(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.scheduler.updateFeeder(user, id, body);
  }

  @RequirePermissions('manageConfig')
  @Delete('misp/feeders/:id')
  deleteFeeder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.scheduler.deleteFeeder(user, id);
  }

  @RequirePermissions('manageAlert/create')
  @Post('misp/feeders/:id/run')
  runFeeder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.scheduler.runFeederForUser(user, id);
  }
}
