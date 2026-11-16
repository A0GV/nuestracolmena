import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';

export const DEFAULT_MITRE_ATTACK_URL = 'https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json';
const BATCH_SIZE = 200;

interface ImportSummary {
  tactics: number;
  techniques: number;
  subtechniques: number;
  revoked: number;
  created: number;
  updated: number;
  durationMs: number;
}

@Injectable()
export class MitreService {
  private readonly logger = new Logger(MitreService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the background job and returns immediately. A second import is
   * rejected while another one is pending/running.
   */
  async startImport(user: AuthUser, options: { url?: string; file?: Buffer }) {
    const running = await this.prisma.job.findFirst({
      where: { type: 'mitre-import', status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (running) throw new ConflictException('Ya hay una importación de MITRE ATT&CK en curso');

    const url = options.file ? undefined : options.url || process.env.MITRE_ATTACK_URL || DEFAULT_MITRE_ATTACK_URL;
    const job = await this.prisma.job.create({
      data: {
        organisationId: user.organisationId,
        type: 'mitre-import',
        status: 'pending',
        payload: { url: url || null, source: options.file ? 'upload' : 'url' },
        result: {},
        createdById: user.id,
      },
    });

    // Detached on purpose: the HTTP request only returns the job id.
    void this.runImport(job.id, options.file, url).catch((error) =>
      this.logger.error(`MITRE import ${job.id} crashed: ${error?.message || error}`),
    );

    return { jobId: job.id };
  }

  async getImportJob(id: string) {
    const job = await this.prisma.job.findFirst({ where: { id, type: 'mitre-import' } });
    if (!job) throw new NotFoundException('Import job not found');
    return job;
  }

  tactics() {
    return this.prisma.tactic.findMany({ orderBy: { order: 'asc' } });
  }

  async deletePattern(patternId: string) {
    const pattern = await this.prisma.pattern.findUnique({ where: { patternId } });
    if (!pattern) throw new NotFoundException('Pattern not found');
    await this.prisma.pattern.delete({ where: { patternId } });
    return { ok: true };
  }

  async deleteTactic(tacticId: string) {
    const tactic = await this.prisma.tactic.findUnique({ where: { tacticId } });
    if (!tactic) throw new NotFoundException('Tactic not found');
    await this.prisma.tactic.delete({ where: { tacticId } });
    return { ok: true };
  }

  private async runImport(jobId: string, file: Buffer | undefined, url: string | undefined) {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date(), result: { phase: 'downloading' } },
    });
    try {
      const bundle = file ? JSON.parse(file.toString('utf8')) : await this.fetchBundle(url);
      await this.prisma.job.update({ where: { id: jobId }, data: { result: { phase: 'importing' } } });
      const summary = await this.importBundle(jobId, bundle);
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: 'Success', finishedAt: new Date(), result: summary as any },
      });
      this.logger.log(
        `MITRE ATT&CK import finished: ${summary.techniques}+${summary.subtechniques} techniques, ${summary.created} created, ${summary.updated} updated in ${summary.durationMs}ms`,
      );
    } catch (error: any) {
      this.logger.warn(`MITRE ATT&CK import failed: ${error?.message || error}`);
      await this.prisma.job
        .update({
          where: { id: jobId },
          data: { status: 'Failure', finishedAt: new Date(), result: { error: String(error?.message || error) } },
        })
        .catch(() => undefined);
    }
  }

  private async fetchBundle(url: string | undefined) {
    if (!url) throw new Error('No URL or file provided');
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Could not download ATT&CK bundle (HTTP ${response.status})`);
    const text = await response.text();
    const parsed = JSON.parse(text);
    // Drop the intermediate string as soon as possible so the 50 MB payload is not kept twice.
    return parsed;
  }

  private async importBundle(jobId: string, bundle: any): Promise<ImportSummary> {
    const started = Date.now();
    const objects: any[] = Array.isArray(bundle) ? bundle : Array.isArray(bundle?.objects) ? bundle.objects : [];
    if (objects.length === 0) throw new Error('The bundle does not contain STIX objects');

    const tacticsRaw = objects.filter((object) => object?.type === 'x-mitre-tactic');
    const matrix = objects.find((object) => object?.type === 'x-mitre-matrix');
    const matrixOrder = new Map<string, number>();
    if (Array.isArray(matrix?.tactic_refs)) {
      matrix.tactic_refs.forEach((ref: string, index: number) => matrixOrder.set(String(ref), index));
    }

    const tactics = tacticsRaw
      .map((raw) => {
        const reference = (raw.external_references || []).find((item: any) => item.source_name === 'mitre-attack');
        return {
          tacticId: reference?.external_id,
          name: raw.name || raw.x_mitre_shortname,
          shortName: raw.x_mitre_shortname,
          description: raw.description || null,
          order: matrixOrder.has(String(raw.id)) ? Number(matrixOrder.get(String(raw.id))) : 1000 + tacticsRaw.indexOf(raw),
        };
      })
      .filter((tactic) => tactic.tacticId && tactic.shortName)
      .sort((a, b) => a.order - b.order);

    if (tactics.length) {
      await this.prisma.$transaction(
        tactics.map((tactic) =>
          this.prisma.tactic.upsert({
            where: { tacticId: tactic.tacticId },
            create: tactic,
            update: { name: tactic.name, shortName: tactic.shortName, description: tactic.description, order: tactic.order },
          }),
        ),
      );
    }

    const nameByShortName = new Map(tactics.map((tactic) => [tactic.shortName, tactic.name]));

    const attackPatterns = objects.filter((object) => object?.type === 'attack-pattern');
    const existing = await this.prisma.pattern.findMany({ select: { patternId: true, isCustom: true } });
    const existingById = new Map(existing.map((pattern) => [pattern.patternId, pattern]));

    let created = 0;
    let updated = 0;
    let techniques = 0;
    let subtechniques = 0;
    let revokedCount = 0;

    const rows: any[] = [];
    for (const raw of attackPatterns) {
      const reference = (raw.external_references || []).find((item: any) => item.source_name === 'mitre-attack');
      const patternId = reference?.external_id;
      if (!patternId) continue;

      const isSubtechnique = !!raw.x_mitre_is_subtechnique;
      if (isSubtechnique) subtechniques++;
      else techniques++;
      const revoked = !!(raw.revoked || raw.x_mitre_deprecated);
      if (revoked) revokedCount++;

      const phases: string[] = (raw.kill_chain_phases || [])
        .filter((phase: any) => phase?.kill_chain_name === 'mitre-attack')
        .map((phase: any) => phase.phase_name);
      const tacticsForPattern = Array.from(new Set(phases.map((phase) => nameByShortName.get(phase) || phase))).filter(Boolean);

      const previous = existingById.get(patternId);
      if (previous?.isCustom) continue;
      if (previous) updated++;
      else created++;

      rows.push({
        patternId,
        name: raw.name || patternId,
        description: raw.description || null,
        tactics: tacticsForPattern,
        platforms: Array.isArray(raw.x_mitre_platforms) ? raw.x_mitre_platforms : [],
        catalog: 'MITRE ATT&CK',
        isCustom: false,
        url: reference?.url || `https://attack.mitre.org/techniques/${String(patternId).replace(/\./g, '/')}/`,
        isSubtechnique,
        parentPatternId: isSubtechnique && String(patternId).includes('.') ? String(patternId).split('.')[0] : null,
        version: raw.x_mitre_version || null,
        revoked,
        dataSources: Array.isArray(raw.x_mitre_data_sources) ? raw.x_mitre_data_sources : [],
        detection: raw.x_mitre_detection || null,
      });
    }

    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      const batch = rows.slice(index, index + BATCH_SIZE);
      await this.prisma.$transaction(
        batch.map((row) =>
          this.prisma.pattern.upsert({
            where: { patternId: row.patternId },
            create: row,
            update: {
              name: row.name,
              description: row.description,
              tactics: row.tactics,
              platforms: row.platforms,
              url: row.url,
              isSubtechnique: row.isSubtechnique,
              parentPatternId: row.parentPatternId,
              version: row.version,
              revoked: row.revoked,
              dataSources: row.dataSources,
              detection: row.detection,
            },
          }),
        ),
      );
      await this.prisma.job
        .update({ where: { id: jobId }, data: { result: { phase: 'importing', progress: { processed: index + batch.length, total: rows.length } } } })
        .catch(() => undefined);
    }

    return {
      tactics: tactics.length,
      techniques,
      subtechniques,
      revoked: revokedCount,
      created,
      updated,
      durationMs: Date.now() - started,
    };
  }
}
