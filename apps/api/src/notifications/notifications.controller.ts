import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { AutomationService } from './automation.service';

@ApiTags('Automation')
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly automation: AutomationService) {}

  // ---------------------------------------------------------------- notifications

  @Get('notifications')
  notifications(@CurrentUser() user: AuthUser) {
    return this.automation.listNotifications(user);
  }

  @RequirePermissions('manageConfig')
  @Post('notifications')
  createNotification(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.automation.createNotification(user, body);
  }

  @RequirePermissions('manageConfig')
  @Get('notifications/deliveries')
  deliveries(@CurrentUser() user: AuthUser, @Query('notificationId') notificationId?: string, @Query('limit') limit?: string) {
    return this.automation.deliveries(user, notificationId, Number(limit || 50));
  }

  @RequirePermissions('manageConfig')
  @Patch('notifications/:id')
  updateNotification(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.automation.updateNotification(user, id, body);
  }

  @RequirePermissions('manageConfig')
  @Delete('notifications/:id')
  deleteNotification(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automation.deleteNotification(user, id);
  }

  @RequirePermissions('manageConfig')
  @Post('notifications/:id/test')
  testNotification(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automation.testNotification(user, id);
  }

  // ---------------------------------------------------------------- endpoints

  @Get('endpoints')
  endpoints(@CurrentUser() user: AuthUser) {
    return this.automation.listEndpoints(user);
  }

  @RequirePermissions('manageConfig')
  @Post('endpoints')
  createEndpoint(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.automation.createEndpoint(user, body);
  }

  @RequirePermissions('manageConfig')
  @Patch('endpoints/:id')
  updateEndpoint(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.automation.updateEndpoint(user, id, body);
  }

  @RequirePermissions('manageConfig')
  @Delete('endpoints/:id')
  deleteEndpoint(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automation.deleteEndpoint(user, id);
  }

  @RequirePermissions('manageConfig')
  @Post('endpoints/:id/test')
  testEndpoint(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.automation.testEndpoint(user, id, body);
  }
}
