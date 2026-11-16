import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../common/decorators/auth.decorators';
import { OrgsService } from './orgs.service';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller()
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get('organisations')
  list() {
    return this.orgs.listOrganisations();
  }

  @Get('organisations/:id')
  get(@Param('id') id: string) {
    return this.orgs.getOrganisation(id);
  }

  @RequirePermissions('manageOrganisation')
  @Post('organisations')
  create(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.orgs.createOrganisation(body, user.id);
  }

  @RequirePermissions('manageOrganisation')
  @Patch('organisations/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.orgs.updateOrganisation(id, body);
  }

  // Organisation-scoped user administration. The service allows platform
  // administrators (manageUser) and org-admins (manageUser/org) only for their
  // own organisation.
  @Get('organisations/:id/users')
  users(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orgs.listUsers(user, id);
  }

  @Post('organisations/:id/users')
  createUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.orgs.createUser(user, id, body);
  }

  @Patch('organisations/:id/users/:userId')
  updateUser(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: any,
  ) {
    return this.orgs.updateMembership(user, id, userId, body);
  }

  @Delete('organisations/:id/users/:userId')
  removeUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    return this.orgs.removeMembership(user, id, userId);
  }

  @Post('organisations/:id/users/:userId/password')
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { password?: string },
  ) {
    return this.orgs.resetUserPassword(user, id, userId, body?.password || '');
  }

  @Get('organisations/:id/users/:userId/api-keys')
  userApiKeys(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    return this.orgs.listUserApiKeys(user, id, userId);
  }

  @Post('organisations/:id/users/:userId/api-keys')
  createUserApiKey(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { name?: string },
  ) {
    return this.orgs.createUserApiKey(user, id, userId, body?.name || 'API key');
  }

  @Delete('organisations/:id/users/:userId/api-keys/:keyId')
  revokeUserApiKey(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.orgs.revokeUserApiKey(user, id, userId, keyId);
  }

  @RequirePermissions('manageUser')
  @Get('users')
  globalUsers() {
    return this.orgs.listGlobalUsers();
  }

  @RequirePermissions('manageUser')
  @Put('users/:id/organisations')
  setUserOrganisations(@Param('id') id: string, @Body() body: { organisations: any[] }) {
    return this.orgs.setUserOrganisations(id, body.organisations);
  }

  @Get('profiles')
  profiles() {
    return this.orgs.listProfiles();
  }

  @RequirePermissions('manageProfile')
  @Post('profiles')
  createProfile(@Body() body: any) {
    return this.orgs.createProfile(body);
  }

  @RequirePermissions('manageProfile')
  @Patch('profiles/:id')
  updateProfile(@Param('id') id: string, @Body() body: any) {
    return this.orgs.updateProfile(id, body);
  }

  @RequirePermissions('manageProfile')
  @Delete('profiles/:id')
  deleteProfile(@Param('id') id: string) {
    return this.orgs.deleteProfile(id);
  }
}
