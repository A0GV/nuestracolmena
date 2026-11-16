import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { AdminService } from './admin.service';

@ApiTags('Administration')
@ApiBearerAuth()
@Controller()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @RequirePermissions('manageConfig')
  @Post('admin/attachments/sweep')
  sweepAttachments() { return this.admin.sweepAttachments(); }

  // Statuses
  @Get('case-statuses')
  caseStatuses(@CurrentUser() user: AuthUser) { return this.admin.caseStatuses(user); }
  @RequirePermissions('manageConfig')
  @Post('case-statuses')
  createCaseStatus(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createCaseStatus(user, body); }
  @RequirePermissions('manageConfig')
  @Patch('case-statuses/:id')
  updateCaseStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updateCaseStatus(user, id, body); }
  @RequirePermissions('manageConfig')
  @Delete('case-statuses/:id')
  deleteCaseStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deleteCaseStatus(user, id); }

  @Get('alert-statuses')
  alertStatuses(@CurrentUser() user: AuthUser) { return this.admin.alertStatuses(user); }
  @RequirePermissions('manageConfig')
  @Post('alert-statuses')
  createAlertStatus(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createAlertStatus(user, body); }
  @RequirePermissions('manageConfig')
  @Patch('alert-statuses/:id')
  updateAlertStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updateAlertStatus(user, id, body); }
  @RequirePermissions('manageConfig')
  @Delete('alert-statuses/:id')
  deleteAlertStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deleteAlertStatus(user, id); }

  // Custom fields
  @Get('custom-fields')
  customFields(@CurrentUser() user: AuthUser) { return this.admin.customFields(user); }
  @RequirePermissions('manageCustomField')
  @Post('custom-fields')
  createCustomField(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createCustomField(user, body); }
  @RequirePermissions('manageCustomField')
  @Patch('custom-fields/:id')
  updateCustomField(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updateCustomField(user, id, body); }
  @RequirePermissions('manageCustomField')
  @Delete('custom-fields/:id')
  deleteCustomField(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deleteCustomField(user, id); }

  // Tags
  @Get('tags')
  tags(@CurrentUser() user: AuthUser) { return this.admin.tags(user); }
  @RequirePermissions('manageTag')
  @Post('tags')
  createTag(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createTag(user, body); }
  @RequirePermissions('manageTag')
  @Patch('tags/:id')
  updateTag(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updateTag(user, id, body); }
  @RequirePermissions('manageTag')
  @Delete('tags/:id')
  deleteTag(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deleteTag(user, id); }

  // ATT&CK patterns
  @Get('patterns')
  patterns(@Query() query: any) { return this.admin.patterns(query); }
  @RequirePermissions('managePattern')
  @Post('patterns')
  createPattern(@Body() body: any) { return this.admin.createPattern(body); }

  // Case templates
  @Get('templates')
  templates(@CurrentUser() user: AuthUser) { return this.admin.templates(user); }
  @RequirePermissions('manageCaseTemplate')
  @Post('templates')
  createTemplate(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createTemplate(user, body); }
  @RequirePermissions('manageCaseTemplate')
  @Patch('templates/:id')
  updateTemplate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updateTemplate(user, id, body); }
  @RequirePermissions('manageCaseTemplate')
  @Delete('templates/:id')
  deleteTemplate(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deleteTemplate(user, id); }

  // Dashboards
  @Get('dashboards')
  dashboards(@CurrentUser() user: AuthUser) { return this.admin.dashboards(user); }
  @RequirePermissions('manageDashboard')
  @Post('dashboards')
  createDashboard(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createDashboard(user, body); }
  @RequirePermissions('manageDashboard')
  @Patch('dashboards/:id')
  updateDashboard(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updateDashboard(user, id, body); }
  @RequirePermissions('manageDashboard')
  @Delete('dashboards/:id')
  deleteDashboard(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deleteDashboard(user, id); }

  // Knowledge base
  @Get('pages')
  pages(@CurrentUser() user: AuthUser) { return this.admin.pages(user); }
  @RequirePermissions('manageKnowledgeBase')
  @Post('pages')
  createPage(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createPage(user, body); }
  @RequirePermissions('manageKnowledgeBase')
  @Patch('pages/:id')
  updatePage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) { return this.admin.updatePage(user, id, body); }
  @RequirePermissions('manageKnowledgeBase')
  @Delete('pages/:id')
  deletePage(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.admin.deletePage(user, id); }
  @Get('page-templates')
  pageTemplates(@CurrentUser() user: AuthUser) { return this.admin.pageTemplates(user); }
  @RequirePermissions('managePageTemplate')
  @Post('page-templates')
  createPageTemplate(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createPageTemplate(user, body); }

  // Audit and settings
  @RequirePermissions('manageConfig')
  @Get('audit')
  audit(@CurrentUser() user: AuthUser) { return this.admin.auditLogs(user); }

  @Get('settings/organisation')
  orgSettings(@CurrentUser() user: AuthUser) { return this.admin.orgSettings(user); }

  @Get('license')
  license() { return this.admin.license(); }

  @Get('platform/status')
  platformStatus() { return this.admin.platformStatus(); }

  // Notifications and endpoints live in the automation module (notifications.controller.ts).
  // Functions live in the functions module (functions.controller.ts).
  // SLA, feeders
  @Get('jobs')
  jobs(@CurrentUser() user: AuthUser) {
    return this.admin.jobs(user);
  }

  @Get('alert-feeders')
  alertFeeders(@CurrentUser() user: AuthUser) { return this.admin.alertFeeders(user); }
  @RequirePermissions('manageAlert/create')
  @Post('alert-feeders')
  createAlertFeeder(@CurrentUser() user: AuthUser, @Body() body: any) { return this.admin.createAlertFeeder(user, body); }
}
