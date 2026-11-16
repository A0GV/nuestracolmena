import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public, CurrentUser, AuthUser } from '../common/decorators/auth.decorators';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: { login: string; password: string }) {
    return this.auth.login(body.login, body.password);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id, user.organisationId);
  }

  @ApiBearerAuth()
  @Post('organisation')
  switchOrg(@CurrentUser() user: AuthUser, @Body() body: { organisation: string }) {
    return this.auth.switchOrganisation(user.id, body.organisation);
  }

  @ApiBearerAuth()
  @Get('api-keys')
  keys(@CurrentUser() user: AuthUser) {
    return this.auth.listApiKeys(user.id);
  }

  @ApiBearerAuth()
  @Post('api-keys')
  createKey(@CurrentUser() user: AuthUser, @Body() body: { name: string }) {
    return this.auth.createApiKey(user.id, body.name);
  }

  @ApiBearerAuth()
  @Delete('api-keys/:id')
  revokeKey(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.auth.revokeApiKey(user.id, id);
  }

  @ApiBearerAuth()
  @Post('password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
  }
}
