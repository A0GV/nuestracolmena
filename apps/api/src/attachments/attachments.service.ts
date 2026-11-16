import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.module';

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), 'uploads');

const ROOT_TYPE: Record<string, string> = {
  case: 'Case',
  alert: 'Alert',
  task: 'Task',
  log: 'Log',
  observable: 'Observable',
  comment: 'Comment',
  page: 'Page',
};

@Injectable()
export class AttachmentsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly hashCache = new Map<string, { md5: string; sha1: string; sha256: string }>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(organisationId: string, objectType?: string, objectId?: string) {
    return this.prisma.attachment.findMany({
      where: { organisationId, ...(objectType ? { objectType } : {}), ...(objectId ? { objectId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, login: true, name: true } } },
    });
  }

  async upload(user: any, file: any, body: any) {
    if (!file) throw new BadRequestException('file is required');
    if (!body.objectType || !body.objectId) throw new BadRequestException('objectType and objectId are required');
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const storageKey = `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const path = join(UPLOAD_DIR, storageKey);
    await fs.writeFile(path, file.buffer);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const attachment = await this.prisma.attachment.create({
      data: {
        organisationId: user.organisationId,
        objectType: body.objectType,
        objectId: body.objectId,
        filename: file.originalname,
        contentType: file.mimetype || 'application/octet-stream',
        size: file.size,
        storageKey,
        sha256,
        createdById: user.id,
      },
    });
    const root = await this.resolveRoot(attachment.organisationId, attachment.objectType, attachment.objectId);
    await this.audit.log({
      organisationId: user.organisationId,
      actorId: user.id,
      action: 'create',
      objectType: 'attachment',
      objectId: attachment.id,
      rootId: root?.rootId ?? attachment.objectId,
      rootType: root?.rootType ?? ROOT_TYPE[attachment.objectType] ?? null,
      details: { objectType: attachment.objectType, objectId: attachment.objectId, filename: attachment.filename, caseId: root?.caseId },
      object: attachment,
    });
    return attachment;
  }

  async getForDownload(id: string) {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException('Attachment not found');
    return { attachment, path: join(UPLOAD_DIR, attachment.storageKey) };
  }

  /** Adds the md5/sha1/sha256 hash list TheHive clients expect to an attachment object. */
  async withHashes<T extends { storageKey?: string; sha256?: string | null }>(attachment: T | null | undefined) {
    if (!attachment) return attachment;
    const hashes = await this.hashesFor(attachment);
    return {
      ...attachment,
      hashes: [
        { algorithm: 'SHA-256', hash: hashes.sha256 },
        { algorithm: 'SHA-1', hash: hashes.sha1 },
        { algorithm: 'MD5', hash: hashes.md5 },
      ],
    };
  }

  async hashesFor(attachment: { storageKey?: string; sha256?: string | null }) {
    const key = attachment?.storageKey || attachment?.sha256 || '';
    const cached = this.hashCache.get(key);
    if (cached) return cached;
    const fallback = { md5: '', sha1: '', sha256: attachment?.sha256 || '' };
    if (!attachment?.storageKey) return fallback;
    try {
      const buffer = await fs.readFile(join(UPLOAD_DIR, attachment.storageKey));
      const hashes = {
        md5: createHash('md5').update(buffer).digest('hex'),
        sha1: createHash('sha1').update(buffer).digest('hex'),
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
      this.hashCache.set(key, hashes);
      return hashes;
    } catch {
      return fallback;
    }
  }

  /** Removes attachments (rows + files) whose owner objects are about to disappear. */
  async removeForOwners(owners: Array<{ objectType: string; objectId: string }>, actorId?: string | null) {
    const unique = [...new Map((owners || []).filter((o) => o?.objectType && o?.objectId).map((o) => [`${o.objectType}:${o.objectId}`, o])).values()];
    if (!unique.length) return { rowsDeleted: 0, filesDeleted: 0 };
    const rows = await this.prisma.attachment.findMany({
      where: { OR: unique.map((owner) => ({ objectType: owner.objectType, objectId: owner.objectId })) },
      select: { id: true },
    });
    return this.removeByIds(rows.map((row) => row.id), actorId);
  }

  async removeByIds(ids: string[], actorId?: string | null) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return { rowsDeleted: 0, filesDeleted: 0 };
    const rows = await this.prisma.attachment.findMany({ where: { id: { in: unique } }, select: { id: true, storageKey: true } });
    let filesDeleted = 0;
    for (const row of rows) {
      try {
        await fs.unlink(join(UPLOAD_DIR, row.storageKey));
        filesDeleted++;
      } catch {
        // Missing files are ignored.
      }
      this.hashCache.delete(row.storageKey);
    }
    const deleted = await this.prisma.attachment.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    return { rowsDeleted: deleted.count, filesDeleted };
  }

  /**
   * Deletes attachment rows whose owner object no longer exists, and files in UPLOAD_DIR
   * without an attachment row that are older than one hour.
   */
  async sweepOrphans() {
    // Comments are polymorphic and have no FK: remove those whose owner no
    // longer exists (and their attachments) before sweeping attachments.
    const commentsDeleted = await this.sweepOrphanComments();

    const attachments = await this.prisma.attachment.findMany({
      select: { id: true, objectType: true, objectId: true, storageKey: true },
    });
    const knownTypes = new Set(Object.keys(ROOT_TYPE));
    const byType = new Map<string, Set<string>>();
    for (const attachment of attachments) {
      if (!knownTypes.has(attachment.objectType)) continue;
      if (!byType.has(attachment.objectType)) byType.set(attachment.objectType, new Set());
      byType.get(attachment.objectType)!.add(attachment.objectId);
    }

    const existing = new Map<string, Set<string>>();
    for (const [objectType, ids] of byType) {
      const idList = [...ids];
      let rows: Array<{ id: string }> = [];
      switch (objectType) {
        case 'case': rows = await this.prisma.case.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'alert': rows = await this.prisma.alert.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'task': rows = await this.prisma.caseTask.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'log': rows = await this.prisma.taskLog.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'observable': rows = await this.prisma.observable.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'comment': rows = await this.prisma.comment.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'page': rows = await this.prisma.page.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        default: break;
      }
      existing.set(objectType, new Set(rows.map((row) => row.id)));
    }

    const orphanRows = attachments.filter((attachment) => {
      const known = existing.get(attachment.objectType);
      return !!known && !known.has(attachment.objectId);
    });
    let filesDeleted = 0;
    for (const row of orphanRows) {
      try {
        await fs.unlink(join(UPLOAD_DIR, row.storageKey));
        filesDeleted++;
      } catch {
        // Missing files are ignored.
      }
      this.hashCache.delete(row.storageKey);
    }
    const rowsDeleted = orphanRows.length
      ? (await this.prisma.attachment.deleteMany({ where: { id: { in: orphanRows.map((row) => row.id) } } })).count
      : 0;

    const remainingKeys = new Set(
      (await this.prisma.attachment.findMany({ select: { storageKey: true } })).map((row) => row.storageKey),
    );
    const cutoff = Date.now() - 60 * 60 * 1000;
    let files: string[] = [];
    try {
      files = await fs.readdir(UPLOAD_DIR);
    } catch {
      files = [];
    }
    for (const filename of files) {
      if (filename.startsWith('.') || remainingKeys.has(filename)) continue;
      const path = join(UPLOAD_DIR, filename);
      try {
        const stat = await fs.stat(path);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        await fs.unlink(path);
        filesDeleted++;
      } catch {
        // Ignore files that disappear while sweeping.
      }
    }

    this.logger.log(
      `Attachment sweep: removed ${rowsDeleted} orphan row(s), ${filesDeleted} orphan file(s), ${commentsDeleted} orphan comment(s)`,
    );
    return { rowsDeleted, filesDeleted, commentsDeleted };
  }

  /** Deletes comments (and their attachments) whose polymorphic owner is gone. */
  private async sweepOrphanComments() {
    const comments = await this.prisma.comment.findMany({
      select: { id: true, objectType: true, objectId: true },
    });
    if (!comments.length) return 0;

    const byType = new Map<string, Set<string>>();
    for (const comment of comments) {
      if (!comment.objectType || !comment.objectId) continue;
      if (!byType.has(comment.objectType)) byType.set(comment.objectType, new Set());
      byType.get(comment.objectType)!.add(comment.objectId);
    }

    const existing = new Map<string, Set<string>>();
    for (const [objectType, ids] of byType) {
      const idList = [...ids];
      let rows: Array<{ id: string }> = [];
      switch (objectType) {
        case 'case': rows = await this.prisma.case.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'alert': rows = await this.prisma.alert.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'task': rows = await this.prisma.caseTask.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'log': rows = await this.prisma.taskLog.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'observable': rows = await this.prisma.observable.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'page': rows = await this.prisma.page.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        case 'procedure': rows = await this.prisma.procedure.findMany({ where: { id: { in: idList } }, select: { id: true } }); break;
        default: continue;
      }
      existing.set(objectType, new Set(rows.map((row) => row.id)));
    }

    const orphan = comments.filter((comment) => {
      const known = existing.get(comment.objectType);
      return !!known && !known.has(comment.objectId);
    });
    if (!orphan.length) return 0;

    await this.removeForOwners(orphan.map((comment) => ({ objectType: 'comment', objectId: comment.id })));
    const deleted = await this.prisma.comment.deleteMany({ where: { id: { in: orphan.map((comment) => comment.id) } } });
    return deleted.count;
  }

  onApplicationBootstrap() {
    if (process.env.ATTACHMENT_SWEEPER === 'false') return;
    const run = () => this.sweepOrphans().catch((error) => this.logger.warn(`Attachment sweep failed: ${error?.message || error}`));
    setTimeout(run, 1000).unref?.();
    this.sweepTimer = setInterval(run, 6 * 60 * 60 * 1000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async remove(id: string, actorId?: string | null) {
    const { attachment, path } = await this.getForDownload(id);
    await fs.unlink(path).catch(() => undefined);
    this.hashCache.delete(attachment.storageKey);
    await this.prisma.attachment.delete({ where: { id } });
    const root = await this.resolveRoot(attachment.organisationId, attachment.objectType, attachment.objectId);
    await this.audit.log({
      organisationId: attachment.organisationId,
      actorId: actorId ?? null,
      action: 'delete',
      objectType: 'attachment',
      objectId: id,
      rootId: root?.rootId ?? attachment.objectId,
      rootType: root?.rootType ?? ROOT_TYPE[attachment.objectType] ?? null,
      details: { objectType: attachment.objectType, objectId: attachment.objectId, filename: attachment.filename, caseId: root?.caseId },
      object: attachment,
    });
    return { ok: true };
  }

  private async resolveRoot(organisationId: string, objectType: string, objectId: string) {
    if (objectType === 'case') {
      const c = await this.prisma.case.findFirst({ where: { id: objectId, organisationId }, select: { id: true } });
      return c ? { rootId: c.id, rootType: 'Case', caseId: c.id } : null;
    }
    if (objectType === 'alert') {
      const a = await this.prisma.alert.findFirst({ where: { id: objectId, organisationId }, select: { id: true } });
      return a ? { rootId: a.id, rootType: 'Alert', caseId: null } : null;
    }
    if (objectType === 'task') {
      const t = await this.prisma.caseTask.findFirst({ where: { id: objectId, organisationId }, select: { caseId: true } });
      return t ? { rootId: t.caseId, rootType: 'Case', caseId: t.caseId } : null;
    }
    if (objectType === 'log') {
      const l = await this.prisma.taskLog.findFirst({ where: { id: objectId, organisationId }, select: { caseId: true } });
      return l ? { rootId: l.caseId, rootType: 'Case', caseId: l.caseId } : null;
    }
    if (objectType === 'observable') {
      const o = await this.prisma.observable.findFirst({ where: { id: objectId, organisationId }, select: { caseId: true, alertId: true } });
      if (!o) return null;
      return o.caseId ? { rootId: o.caseId, rootType: 'Case', caseId: o.caseId } : { rootId: o.alertId, rootType: 'Alert', caseId: null };
    }
    return null;
  }
}
