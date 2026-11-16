import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSIONS } from '../common/permissions';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(login: string, password: string) {
    if (!login || !password) throw new BadRequestException('login and password are required');
    const user = await this.prisma.user.findUnique({
      where: { login: login.toLowerCase() },
      include: {
        memberships: {
          include: { profile: true, organisation: true },
        },
      },
    });
    if (!user || !user.passwordHash || user.locked) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const membership =
      user.memberships.find((m) => m.isDefault) ||
      user.memberships.find((m) => m.organisationId === user.defaultOrganisationId) ||
      user.memberships[0];
    if (!membership) throw new UnauthorizedException('User has no organisation');

    const token = await this.jwt.signAsync({
      sub: user.id,
      login: user.login,
      organisationId: membership.organisationId,
    });

    return {
      token,
      user: this.publicUser(user),
      activeOrganisation: membership.organisation.name,
      organisations: user.memberships.map((m) => ({
        id: m.organisationId,
        name: m.organisation.name,
        profile: m.profile.name,
        isDefault: m.isDefault,
      })),
    };
  }

  async me(userId: string, organisationId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { profile: true, organisation: true } } },
    });
    if (!user) throw new UnauthorizedException('User unavailable');
    const membership = user.memberships.find((m) => m.organisationId === organisationId);
    return {
      ...this.publicUser(user),
      activeOrganisation: membership?.organisation.name ?? null,
      organisations: user.memberships.map((m) => ({
        id: m.organisationId,
        name: m.organisation.name,
        profile: m.profile.name,
        isDefault: m.isDefault,
      })),
      profile: membership?.profile.name,
      permissions: membership?.profile.type === 'admin'
        ? [...ALL_PERMISSIONS]
        : ((membership?.profile.permissions as string[]) || []),
    };
  }

  async switchOrganisation(userId: string, organisation: string) {
    const membership = await this.prisma.organisationUser.findFirst({
      where: { userId, organisation: { name: organisation } },
      include: { organisation: true },
    });
    if (!membership) throw new BadRequestException('Organisation not available');
    const token = await this.jwt.signAsync({ sub: userId, organisationId: membership.organisationId });
    return { token, activeOrganisation: membership.organisation.name };
  }

  async listApiKeys(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createApiKey(userId: string, name: string) {
    const raw = `mh_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const key = await this.prisma.apiKey.create({
      data: { userId, name: name || 'API key', keyHash, prefix: raw.slice(0, 10) },
    });
    return { id: key.id, name: key.name, prefix: key.prefix, key: raw, createdAt: key.createdAt };
  }

  async revokeApiKey(userId: string, id: string) {
    await this.prisma.apiKey.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (user.passwordHash) {
      const ok = await bcrypt.compare(currentPassword || '', user.passwordHash);
      if (!ok) throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { ok: true };
  }

  private publicUser(user: any) {
    return {
      id: user.id,
      login: user.login,
      name: user.name,
      email: user.email,
      type: user.type,
      locked: user.locked,
      mfaEnabled: user.mfaEnabled,
      createdAt: user.createdAt,
    };
  }
}
