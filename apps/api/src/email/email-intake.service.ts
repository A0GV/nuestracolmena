import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { AuthUser } from '../common/decorators/auth.decorators';
import { EmailParserService, ParsedEmail } from './email-parser.service';

export interface ImportOptions {
  source: string;
  tlp?: number;
  severity?: number;
  tags?: string[];
}

export interface ImportResult {
  alertId: string | null;
  created: boolean;
  sourceRef?: string;
  title?: string;
  error?: string;
}

@Injectable()
export class EmailIntakeService {
  private readonly logger = new Logger(EmailIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: EmailParserService,
    private readonly alerts: AlertsService,
  ) {}

  /** Parses a raw RFC822 message and creates an alert (idempotent by Message-ID). */
  async importRaw(user: AuthUser, raw: Buffer, options: ImportOptions): Promise<ImportResult> {
    const parsed = await this.parser.parse(raw);
    return this.createAlert(user, parsed, options);
  }

  async importFiles(user: AuthUser, files: any[], options: ImportOptions) {
    const results: Array<ImportResult & { filename: string }> = [];
    for (const file of files || []) {
      const filename = String(file?.originalname || 'message.eml');
      try {
        if (!file?.buffer?.length) throw new Error('Fichero vacío');
        const result = await this.importRaw(user, file.buffer, options);
        results.push({ ...result, filename });
      } catch (error: any) {
        this.logger.warn(`E-mail import ${filename}: ${error?.message || error}`);
        results.push({ filename, alertId: null, created: false, error: error?.message || String(error) });
      }
    }
    return {
      results,
      created: results.filter((row) => row.created).length,
      unchanged: results.filter((row) => !row.created && !row.error).length,
      errors: results.filter((row) => row.error).length,
    };
  }

  private async createAlert(user: AuthUser, parsed: ParsedEmail, options: ImportOptions): Promise<ImportResult> {
    const existing = await this.prisma.alert.findUnique({
      where: {
        organisationId_type_source_sourceRef: {
          organisationId: user.organisationId,
          type: 'email',
          source: options.source,
          sourceRef: parsed.sourceRef,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { alertId: existing.id, created: false, sourceRef: parsed.sourceRef, title: parsed.title };
    }

    const tlp = Number(options.tlp ?? 2);
    const severity = Number(options.severity ?? 2);
    const tags = [...new Set([
      'email',
      ...(parsed.reported ? ['phishing-report'] : []),
      ...(options.tags || []).map(String).filter(Boolean),
    ])];

    let alert: any;
    try {
      alert = await this.alerts.create(user, {
        type: 'email',
        source: options.source,
        sourceRef: parsed.sourceRef,
        title: parsed.title,
        description: parsed.description,
        date: parsed.date,
        severity,
        tlp,
        pap: 2,
        tags,
        observables: parsed.observables.map((observable) => ({
          ...observable,
          tlp,
          pap: 2,
          ioc: false,
        })),
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const raced = await this.prisma.alert.findUnique({
          where: {
            organisationId_type_source_sourceRef: {
              organisationId: user.organisationId,
              type: 'email',
              source: options.source,
              sourceRef: parsed.sourceRef,
            },
          },
          select: { id: true },
        });
        if (raced) return { alertId: raced.id, created: false, sourceRef: parsed.sourceRef, title: parsed.title };
      }
      throw error;
    }

    if (parsed.attachments.length) {
      try {
        const attachments = parsed.attachments.map((attachment) => ({
          originalname: attachment.filename,
          mimetype: attachment.contentType,
          buffer: attachment.content,
          size: attachment.content.length,
        }));
        await this.alerts.createFileObservables(user, alert.id, attachments, {
          message: 'Adjunto del correo',
          tlp,
          pap: 2,
          ioc: false,
          tags,
          addHashes: true,
        });
      } catch (error: any) {
        this.logger.warn(`Attachments for alert ${alert.id}: ${error?.message || error}`);
      }
    }

    try {
      await this.alerts.createFileObservables(user, alert.id, [{
        originalname: 'original-email.eml',
        mimetype: 'message/rfc822',
        buffer: parsed.raw,
        size: parsed.raw.length,
      }], {
        message: 'Mensaje original',
        tlp,
        pap: 2,
        ioc: false,
        tags: ['original-email'],
        addHashes: true,
      });
    } catch (error: any) {
      this.logger.warn(`Original message for alert ${alert.id}: ${error?.message || error}`);
    }

    return { alertId: alert.id, created: true, sourceRef: parsed.sourceRef, title: parsed.title };
  }
}
