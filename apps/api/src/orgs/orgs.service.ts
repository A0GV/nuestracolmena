import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { PROFILE_DEFINITIONS } from '../common/permissions';

const SAFE_USER_SELECT = {
  id: true,
  login: true,
  name: true,
  email: true,
  type: true,
  locked: true,
  mfaEnabled: true,
  createdAt: true,
} as const;

@Injectable()
export class OrgsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrgsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Built-in profiles are code, not data: update the system rows at startup so
   * existing installations receive permission changes. Custom profiles are
   * never touched and users keep their profile assignment.
   */
  async onApplicationBootstrap() {
    await this.ensureSystemProfiles().catch((error) =>
      this.logger.warn(`Could not ensure system profiles: ${error?.message || error}`),
    );
    await this.normaliseProcedureTactics().catch((error) =>
      this.logger.warn(`Could not normalise procedure tactics: ${error?.message || error}`),
    );
  }

  private async ensureSystemProfiles() {
    for (const [name, definition] of Object.entries(PROFILE_DEFINITIONS)) {
      const existing = await this.prisma.profile.findUnique({ where: { name } });
      if (!existing) {
        await this.prisma.profile.create({
          data: {
            name,
            type: definition.type,
            permissions: definition.permissions as any,
            isSystem: true,
          },
        });
        continue;
      }
      if (!existing.isSystem) continue;
      await this.prisma.profile.update({
        where: { id: existing.id },
        data: { type: definition.type, permissions: definition.permissions as any },
      });
    }
  }

  private async normaliseProcedureTactics() {
    const tactics = await this.prisma.tactic.findMany({ select: { shortName: true, name: true } });
    if (!tactics.length) return;
    let updated = 0;
    for (const tactic of tactics) {
      if (!tactic.shortName || !tactic.name || tactic.shortName === tactic.name) continue;
      const result = await this.prisma.procedure.updateMany({
        where: { tactic: { equals: tactic.shortName, mode: 'insensitive' } },
        data: { tactic: tactic.name },
      });
      updated += result.count;
    }
    if (updated) this.logger.log(`Normalised ${updated} procedure tactic name(s)`);
  }

  private async resolveOrganisation(idOrName: string) {
    const org = await this.prisma.organisation.findFirst({
      where: { OR: [{ id: idOrName }, { name: idOrName }] },
    });
    if (!org) throw new NotFoundException('Organisation not found');
    return org;
  }

  private assertOrgUserAdmin(user: AuthUser, organisationId: string) {
    if (user.isPlatformAdmin || user.permissions?.includes('manageUser')) return;
    const allowed = user.permissions?.includes('manageUser/org') && user.organisationId === organisationId;
    if (!allowed) throw new ForbiddenException('Missing permission: manageUser/org');
  }

  private async targetMembership(user: AuthUser, organisationId: string, userId: string) {
    const membership = await this.prisma.organisationUser.findFirst({
      where: { organisationId, userId },
      include: { user: true, profile: true },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    if (!user.isPlatformAdmin) {
      const platformAdmin = await this.prisma.organisationUser.findFirst({
        where: { userId, profile: { type: 'admin' } },
        select: { id: true },
      });
      if (platformAdmin) throw new ForbiddenException('Cannot manage a platform administrator');
    }
    return membership;
  }

  private validateAssignableProfile(user: AuthUser, profile: { type: string }) {
    if (user.isPlatformAdmin) return;
    if (profile.type === 'admin') throw new ForbiddenException('Only platform administrators can assign the admin profile');
    if (profile.type !== 'organisation') {
      throw new ForbiddenException('Organisation administrators can only assign organisation profiles');
    }
  }

  listOrganisations() {
    return this.prisma.organisation.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true, cases: true, alerts: true } } },
    });
  }

  getOrganisation(idOrName: string) {
    return this.prisma.organisation.findFirst({
      where: { OR: [{ id: idOrName }, { name: idOrName }] },
      include: { _count: { select: { users: true, cases: true, alerts: true } }, linksFrom: { include: { toOrg: true } } },
    });
  }

  async createOrganisation(data: any, actorId: string) {
    if (!data.name) throw new BadRequestException('name is required');
    const org = await this.prisma.organisation.create({
      data: {
        name: data.name,
        description: data.description || '',
        taskRule: data.taskRule || 'manual',
        observableRule: data.observableRule || 'manual',
        createdById: actorId,
      },
    });
    await this.seedStatuses(org.id);
    return org;
  }

  async updateOrganisation(idOrName: string, data: any) {
    const org = await this.getOrganisation(idOrName);
    if (!org) throw new NotFoundException('Organisation not found');
    return this.prisma.organisation.update({
      where: { id: org.id },
      data: {
        name: data.name ?? undefined,
        description: data.description ?? undefined,
        taskRule: data.taskRule ?? undefined,
        observableRule: data.observableRule ?? undefined,
        locked: data.locked ?? undefined,
      },
    });
  }

  async listUsers(user: AuthUser, idOrName: string) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    const memberships = await this.prisma.organisationUser.findMany({
      where: { organisationId: org.id },
      include: {
        user: { select: SAFE_USER_SELECT },
        profile: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const platformAdmins = await this.prisma.organisationUser.findMany({
      where: {
        userId: { in: memberships.map((membership) => membership.userId) },
        profile: { type: 'admin' },
      },
      select: { userId: true },
    });
    const adminIds = new Set(platformAdmins.map((row) => row.userId));
    return memberships.map((membership) => ({ ...membership, platformAdmin: adminIds.has(membership.userId) }));
  }

  listGlobalUsers() {
    return this.prisma.user.findMany({
      select: {
        ...SAFE_USER_SELECT,
        updatedAt: true,
        memberships: { include: { organisation: true, profile: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createUser(user: AuthUser, idOrName: string, data: any) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    if (!data.login || !data.name) throw new BadRequestException('login and name are required');
    const profile = await this.prisma.profile.findUnique({ where: { name: data.profile || 'analyst' } });
    if (!profile) throw new BadRequestException('Profile not found');
    this.validateAssignableProfile(user, profile);
    const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;
    const created = await this.prisma.user.create({
      data: {
        login: data.login.toLowerCase(),
        name: data.name,
        email: data.email || data.login,
        passwordHash,
        type: data.type || 'normal',
        defaultOrganisationId: org.id,
        memberships: {
          create: { organisationId: org.id, profileId: profile.id, isDefault: true },
        },
      },
    });
    return this.prisma.organisationUser.findFirst({
      where: { userId: created.id, organisationId: org.id },
      include: { user: { select: SAFE_USER_SELECT }, profile: { select: { id: true, name: true, type: true } } },
    });
  }

  async updateMembership(user: AuthUser, idOrName: string, userId: string, data: any) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    const membership = await this.targetMembership(user, org.id, userId);

    let profileId = data.profileId;
    if (data.profile || data.profileId) {
      const profile = data.profile
        ? await this.prisma.profile.findUnique({ where: { name: data.profile } })
        : await this.prisma.profile.findUnique({ where: { id: data.profileId } });
      if (!profile) throw new BadRequestException('Profile not found');
      this.validateAssignableProfile(user, profile);
      profileId = profile.id;
    }

    const userData: any = {};
    if (data.locked !== undefined) userData.locked = !!data.locked;
    if (data.name !== undefined) userData.name = data.name;
    if (data.email !== undefined) userData.email = data.email;
    if (data.password) {
      if (String(data.password).length < 8) throw new BadRequestException('Password must be at least 8 characters');
      userData.passwordHash = await bcrypt.hash(String(data.password), 10);
    }
    if (Object.keys(userData).length) {
      await this.prisma.user.update({ where: { id: userId }, data: userData });
    }
    if (profileId && profileId !== membership.profileId) {
      await this.prisma.organisationUser.update({ where: { id: membership.id }, data: { profileId } });
    }
    return this.prisma.organisationUser.findUnique({
      where: { id: membership.id },
      include: { user: { select: SAFE_USER_SELECT }, profile: { select: { id: true, name: true, type: true } } },
    });
  }

  async removeMembership(user: AuthUser, idOrName: string, userId: string) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    const membership = await this.targetMembership(user, org.id, userId);
    await this.prisma.organisationUser.delete({ where: { id: membership.id } });
    if (membership.isDefault) {
      const next = await this.prisma.organisationUser.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      await this.prisma.user.update({
        where: { id: userId },
        data: { defaultOrganisationId: next?.organisationId ?? null },
      });
    }
    return { ok: true };
  }

  async resetUserPassword(user: AuthUser, idOrName: string, userId: string, password: string) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    await this.targetMembership(user, org.id, userId);
    if (!password || String(password).length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(String(password), 10) },
    });
    return { ok: true };
  }

  async listUserApiKeys(user: AuthUser, idOrName: string, userId: string) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    await this.targetMembership(user, org.id, userId);
    return this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createUserApiKey(user: AuthUser, idOrName: string, userId: string, name: string) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    await this.targetMembership(user, org.id, userId);
    const raw = `mh_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const key = await this.prisma.apiKey.create({
      data: { userId, name: name || 'API key', keyHash, prefix: raw.slice(0, 10) },
    });
    return { id: key.id, name: key.name, prefix: key.prefix, key: raw, createdAt: key.createdAt };
  }

  async revokeUserApiKey(user: AuthUser, idOrName: string, userId: string, keyId: string) {
    const org = await this.resolveOrganisation(idOrName);
    this.assertOrgUserAdmin(user, org.id);
    await this.targetMembership(user, org.id, userId);
    await this.prisma.apiKey.updateMany({
      where: { id: keyId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async setUserOrganisations(userId: string, organisations: any[]) {
    if (!Array.isArray(organisations)) throw new BadRequestException('organisations must be an array');
    const resolved: any[] = [];
    for (const item of organisations) {
      const org = await this.prisma.organisation.findFirst({ where: { OR: [{ id: item.organisation }, { name: item.organisation }] } });
      const profile = await this.prisma.profile.findUnique({ where: { name: item.profile || 'analyst' } });
      if (!org || !profile) throw new BadRequestException('Organisation or profile not found');
      resolved.push({ org, profile, isDefault: !!item.default });
    }
    await this.prisma.organisationUser.deleteMany({ where: { userId } });
    for (const r of resolved) {
      await this.prisma.organisationUser.create({
        data: { userId, organisationId: r.org.id, profileId: r.profile.id, isDefault: r.isDefault },
      });
      if (r.isDefault) {
        await this.prisma.user.update({ where: { id: userId }, data: { defaultOrganisationId: r.org.id } });
      }
    }
    return this.prisma.organisationUser.findMany({ where: { userId }, include: { organisation: true, profile: true } });
  }

  listProfiles() {
    return this.prisma.profile.findMany({ orderBy: { name: 'asc' } });
  }

  createProfile(data: any) {
    return this.prisma.profile.create({
      data: {
        name: data.name,
        type: data.type || 'organisation',
        permissions: data.permissions || [],
      },
    });
  }

  updateProfile(id: string, data: any) {
    return this.prisma.profile.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        type: data.type ?? undefined,
        permissions: data.permissions ?? undefined,
      },
    });
  }

  deleteProfile(id: string) {
    return this.prisma.profile.delete({ where: { id } });
  }

  private async seedStatuses(orgId: string) {
    const caseStatuses = [
      { value: 'New', stage: 'New', order: 0, colour: '#4a90e2' },
      { value: 'InProgress', stage: 'InProgress', order: 1, colour: '#faad14' },
      { value: 'TruePositive', stage: 'Closed', order: 2, colour: '#d0021b', requiresImpact: true },
      { value: 'FalsePositive', stage: 'Closed', order: 3, colour: '#52c41a' },
      { value: 'Indeterminate', stage: 'Closed', order: 4, colour: '#4a90e2' },
      { value: 'Duplicated', stage: 'Closed', order: 5, colour: '#a7a7b6' },
      { value: 'Other', stage: 'Closed', order: 6, colour: '#4a90e2' },
    ];
    const alertStatuses = [
      { value: 'New', stage: 'New', order: 0, colour: '#4a90e2' },
      { value: 'InProgress', stage: 'InProgress', order: 1, colour: '#faad14' },
      { value: 'Pending', stage: 'InProgress', order: 2, colour: '#13c2c2' },
      { value: 'Imported', stage: 'Imported', order: 3, colour: '#52c41a' },
      { value: 'FalsePositive', stage: 'Closed', order: 4, colour: '#52c41a' },
      { value: 'Duplicate', stage: 'Closed', order: 5, colour: '#a7a7b6' },
      { value: 'Ignored', stage: 'Closed', order: 6, colour: '#a7a7b6' },
    ];
    await this.prisma.caseStatus.createMany({
      data: caseStatuses.map((s) => ({ ...s, organisationId: orgId })),
      skipDuplicates: true,
    });
    await this.prisma.alertStatus.createMany({
      data: alertStatuses.map((s) => ({ ...s, organisationId: orgId })),
      skipDuplicates: true,
    });
  }
}
