import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { ImapFeederService } from './imap-feeder.service';

@ApiTags('Email intake')
@ApiBearerAuth()
@Controller('email')
export class EmailController {
  constructor(private readonly feeders: ImapFeederService) {}

  @RequirePermissions('manageConfig')
  @Get('feeders')
  list(@CurrentUser() user: AuthUser) {
    return this.feeders.listFeeders(user);
  }

  @RequirePermissions('manageConfig')
  @Post('feeders')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.feeders.createFeeder(user, body);
  }

  @RequirePermissions('manageConfig')
  @Patch('feeders/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.feeders.updateFeeder(user, id, body);
  }

  @RequirePermissions('manageConfig')
  @Delete('feeders/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.feeders.deleteFeeder(user, id);
  }

  @RequirePermissions('manageConfig')
  @Post('feeders/:id/test')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.feeders.testFeeder(user, id);
  }

  @RequirePermissions('manageConfig')
  @Post('feeders/:id/run')
  run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.feeders.runForUser(user, id);
  }
}
