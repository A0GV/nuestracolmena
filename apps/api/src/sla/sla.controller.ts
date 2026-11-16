import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { SlaService } from './sla.service';

@ApiTags('SLA')
@ApiBearerAuth()
@Controller()
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get('sla-rules')
  listRules(@CurrentUser() user: AuthUser) {
    return this.sla.listRules(user);
  }

  @RequirePermissions('manageConfig')
  @Post('sla-rules')
  createRule(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.sla.createRule(user, body);
  }

  @RequirePermissions('manageConfig')
  @Patch('sla-rules/:id')
  updateRule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.sla.updateRule(user, id, body);
  }

  @RequirePermissions('manageConfig')
  @Delete('sla-rules/:id')
  deleteRule(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sla.deleteRule(user, id);
  }

  @RequirePermissions('manageConfig')
  @Post('sla-rules/:id/preview')
  preview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sla.preview(user, id);
  }

  @Get('sla/summary')
  summary(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.sla.summary(user, from, to);
  }

  @RequirePermissions('manageConfig')
  @Post('sla/evaluate-now')
  evaluateNow(@CurrentUser() user: AuthUser) {
    return this.sla.runPass({ organisationId: user.organisationId });
  }
}
