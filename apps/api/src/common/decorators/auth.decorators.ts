import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const Public = () => SetMetadata('isPublic', true);

export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata('permissions', permissions);

export interface AuthUser {
  id: string;
  login: string;
  name: string;
  organisationId: string;
  profileId: string;
  profileName: string;
  permissions: string[];
  isPlatformAdmin: boolean;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
