import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { EmailIntakeService } from './email-intake.service';

const MASK = '********';

export interface ImapFeederConfig {
  type: 'imap';
  host: string;
  port: number;
  secure: boolean;
  verifyTls: boolean;
  user: string;
  password: string;
  mailbox: string;
  intervalMinutes: number;
  markSeen: boolean;
  moveTo?: string;
  maxPerRun: number;
  tlp: number;
  severity: number;
  tags: string[];
  lastRunAt?: string;
  lastResult?: any;
}

@Injectable()
export class ImapFeederService {
  private readonly logger = new Logger(ImapFeederService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: EmailIntakeService,
  ) {}

  async listFeeders(user: AuthUser) {
    const rows = await this.prisma.alertFeeder.findMany({
      where: { organisationId: user.organisationId, config: { path: ['type'], equals: 'imap' } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.publicView(row));
  }

  async createFeeder(user: AuthUser, body: any) {
    if (!String(body?.name || '').trim()) throw new BadRequestException('name is required');
    const config = this.feederConfig(body, {});
    const feeder = await this.prisma.alertFeeder.create({
      data: {
        organisationId: user.organisationId,
        name: String(body.name).trim(),
        enabled: body?.enabled !== false,
        config: config as any,
        createdById: user.id,
      },
    });
    return this.publicView(feeder);
  }

  async updateFeeder(user: AuthUser, id: string, body: any) {
    const feeder = await this.getFeeder(user, id);
    const config = this.feederConfig({ ...(feeder.config as any), ...body }, feeder.config as any);
    const updated = await this.prisma.alertFeeder.update({
      where: { id },
      data: {
        name: body?.name !== undefined ? String(body.name).trim() : undefined,
        enabled: body?.enabled ?? undefined,
        config: config as any,
      },
    });
    return this.publicView(updated);
  }

  async deleteFeeder(user: AuthUser, id: string) {
    await this.getFeeder(user, id);
    await this.prisma.alertFeeder.delete({ where: { id } });
    return { ok: true };
  }

  async testFeeder(user: AuthUser, id: string) {
    const feeder = await this.getFeeder(user, id);
    const cfg = feeder.config as unknown as ImapFeederConfig;
    const client = this.client(cfg);
    try {
      await client.connect();
      const status = await client.status(cfg.mailbox || 'INBOX', { messages: true, unseen: true });
      return {
        ok: true,
        mailbox: cfg.mailbox || 'INBOX',
        messages: status ? Number(status.messages || 0) : 0,
        unseen: status ? Number(status.unseen || 0) : 0,
      };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    } finally {
      await this.logout(client);
    }
  }

  async runForUser(user: AuthUser, id: string) {
    await this.getFeeder(user, id);
    return this.runFeeder(id);
  }

  async runFeeder(id: string) {
    const feeder = await this.prisma.alertFeeder.findUnique({ where: { id } });
    if (!feeder) throw new NotFoundException('Feeder not found');
    const cfg = feeder.config as unknown as ImapFeederConfig;
    if (cfg?.type !== 'imap') throw new BadRequestException('Not an IMAP feeder');
    const startedAt = new Date();
    let lastResult: any;
    try {
      const actor = await this.resolveActor(feeder.organisationId, feeder.createdById);
      lastResult = await this.process(feeder.name, cfg, actor);
      if (lastResult.created) this.logger.log(`IMAP feeder ${feeder.name}: ${lastResult.created} new alert(s)`);
    } catch (error: any) {
      this.logger.warn(`IMAP feeder ${feeder.name}: ${error?.message || error}`);
      lastResult = { ok: false, fetched: 0, created: 0, unchanged: 0, errors: [error?.message || String(error)] };
    }
    const updated = await this.prisma.alertFeeder.update({
      where: { id },
      data: { config: { ...cfg, lastRunAt: startedAt.toISOString(), lastResult } },
    });
    return this.publicView(updated);
  }

  private async process(source: string, cfg: ImapFeederConfig, user: AuthUser) {
    const maxPerRun = Math.max(1, Math.min(500, Number(cfg.maxPerRun || 50)));
    const errors: string[] = [];
    let fetched = 0;
    let created = 0;
    let unchanged = 0;

    const client = this.client(cfg);
    await client.connect();
    const mailbox = cfg.mailbox || 'INBOX';
    const lock = await client.getMailboxLock(mailbox);
    try {
      const found = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(found) ? found.slice(0, maxPerRun) : [];
      for (const uid of uids) {
        fetched++;
        try {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message || !message.source) {
            errors.push(`UID ${uid}: mensaje vacío`);
            continue;
          }
          const result = await this.intake.importRaw(user, message.source, {
            source,
            tlp: Number(cfg.tlp ?? 2),
            severity: Number(cfg.severity ?? 2),
            tags: Array.isArray(cfg.tags) ? cfg.tags : [],
          });
          if (result.created) created++;
          else unchanged++;
          if (cfg.moveTo) {
            await client.messageMove(uid, cfg.moveTo, { uid: true });
          } else if (cfg.markSeen !== false) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          }
        } catch (error: any) {
          errors.push(`UID ${uid}: ${error?.message || error}`);
        }
      }
    } finally {
      try { lock.release(); } catch { /* lock already released */ }
      await this.logout(client);
    }

    return { ok: errors.length === 0, fetched, created, unchanged, errors };
  }

  private client(cfg: ImapFeederConfig) {
    return new ImapFlow({
      host: cfg.host,
      port: Number(cfg.port || 993),
      secure: cfg.secure !== false,
      auth: { user: cfg.user, pass: cfg.password || '' },
      logger: false,
      tls: cfg.secure === false ? undefined : { rejectUnauthorized: cfg.verifyTls !== false },
    } as any);
  }

  private async logout(client: ImapFlow) {
    try {
      await client.logout();
    } catch {
      try { client.close(); } catch { /* ignore */ }
    }
  }

  private async resolveActor(organisationId: string, createdById?: string | null): Promise<AuthUser> {
    let found = createdById
      ? await this.prisma.user.findUnique({ where: { id: createdById } })
      : null;
    if (!found) {
      const membership = await this.prisma.organisationUser.findFirst({
        where: { organisationId },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      });
      found = membership?.user || null;
    }
    if (!found) throw new BadRequestException('No user available to own imported alerts');
    return {
      id: found.id,
      login: found.login,
      name: found.name,
      organisationId,
      profileId: '',
      profileName: 'imap-feeder',
      permissions: [],
      isPlatformAdmin: false,
    };
  }

  private async getFeeder(user: AuthUser, id: string) {
    const feeder = await this.prisma.alertFeeder.findFirst({
      where: { id, organisationId: user.organisationId, config: { path: ['type'], equals: 'imap' } },
    });
    if (!feeder) throw new NotFoundException('Feeder not found');
    return feeder;
  }

  private publicView(feeder: any) {
    const config: any = feeder.config || {};
    return {
      ...feeder,
      config: {
        ...config,
        password: config.password ? MASK : '',
      },
    };
  }

  private feederConfig(body: any, previous: any): ImapFeederConfig {
    const host = String(body?.host ?? previous.host ?? '').trim();
    const user = String(body?.user ?? previous.user ?? '').trim();
    if (!host) throw new BadRequestException('host is required');
    if (!user) throw new BadRequestException('user is required');

    const password = body?.password !== undefined && body.password !== MASK
      ? String(body.password)
      : String(previous.password || '');

    return {
      ...previous,
      type: 'imap',
      host,
      port: Math.max(1, Math.min(65535, Number(body?.port ?? previous.port ?? 993))),
      secure: body?.secure !== undefined ? !!body.secure : previous.secure !== undefined ? !!previous.secure : true,
      verifyTls: body?.verifyTls !== undefined ? !!body.verifyTls : previous.verifyTls !== undefined ? !!previous.verifyTls : true,
      user,
      password,
      mailbox: String(body?.mailbox ?? previous.mailbox ?? 'INBOX') || 'INBOX',
      intervalMinutes: Math.max(1, Number(body?.intervalMinutes ?? previous.intervalMinutes ?? 5)),
      markSeen: body?.markSeen !== undefined ? !!body.markSeen : previous.markSeen !== undefined ? !!previous.markSeen : true,
      moveTo: String(body?.moveTo ?? previous.moveTo ?? '').trim() || undefined,
      maxPerRun: Math.max(1, Math.min(500, Number(body?.maxPerRun ?? previous.maxPerRun ?? 50))),
      tlp: Number(body?.tlp ?? previous.tlp ?? 2),
      severity: Number(body?.severity ?? previous.severity ?? 2),
      tags: Array.isArray(body?.tags) ? body.tags.map(String).filter(Boolean) : Array.isArray(previous.tags) ? previous.tags : [],
      lastRunAt: previous.lastRunAt,
      lastResult: previous.lastResult,
    };
  }
}
