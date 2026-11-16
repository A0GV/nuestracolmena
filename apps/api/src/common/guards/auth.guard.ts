import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { ALL_PERMISSIONS } from '../permissions';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    let payload: any;
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) throw new UnauthorizedException('Invalid Basic credentials');
      const login = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      try {
        const result = await this.auth.login(login, password);
        payload = { sub: result.user.id };
      } catch {
        throw new UnauthorizedException('Invalid credentials');
      }
    } else if (token) {
      if (token.startsWith('mh_')) {
        // Personal API key (created in Settings → API keys)
        const keyHash = createHash('sha256').update(token).digest('hex');
        const key = await this.prisma.apiKey.findUnique({ where: { keyHash } });
        if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) {
          throw new UnauthorizedException('Invalid or revoked API key');
        }
        this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
        payload = { sub: key.userId };
      } else {
        try {
          payload = await this.jwt.verifyAsync(token);
        } catch {
          throw new UnauthorizedException('Invalid or expired token');
        }
      }
    } else {
      throw new UnauthorizedException('Authentication required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { memberships: { include: { profile: true, organisation: true } } },
    });
    if (!user || user.locked) throw new UnauthorizedException('User unavailable');

    const organisationHeader = request.headers['x-organisation'] as string | undefined;
    let requestedOrg: string;
    let membership: any;
    if (organisationHeader) {
      requestedOrg = organisationHeader;
      membership =
        user.memberships.find((m) => m.organisation.name === requestedOrg) ||
        user.memberships.find((m) => m.organisationId === requestedOrg);
      if (!membership) throw new ForbiddenException('Organisation not available');
    } else {
      requestedOrg = payload.organisationId || user.defaultOrganisationId;
      membership =
        user.memberships.find((m) => m.organisation.name === requestedOrg) ||
        user.memberships.find((m) => m.organisationId === requestedOrg) ||
        user.memberships.find((m) => m.isDefault) ||
        user.memberships[0];
    }

    if (!membership) throw new ForbiddenException('No organisation membership');

    const profilePermissions = (membership.profile.permissions as string[]) || [];
    const isPlatformAdmin = membership.profile.type === 'admin';
    const permissions = isPlatformAdmin ? ALL_PERMISSIONS : profilePermissions;

    request.user = {
      id: user.id,
      login: user.login,
      name: user.name,
      organisationId: membership.organisationId,
      profileId: membership.profileId,
      profileName: membership.profile.name,
      permissions,
      isPlatformAdmin,
    };

    const required = this.reflector.getAllAndOverride<string[]>('permissions', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length) {
      const ok = required.every((p) => permissions.includes(p));
      if (!ok) throw new ForbiddenException(`Missing permission: ${required.join(', ')}`);
    }

    return true;
  }
}
