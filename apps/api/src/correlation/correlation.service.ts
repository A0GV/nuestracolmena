import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/decorators/auth.decorators';

const CASE_SUMMARY = {
  id: true,
  number: true,
  title: true,
  severity: true,
  stage: true,
  closedAt: true,
  createdAt: true,
  mergedIntoCaseId: true,
  status: { select: { value: true } },
} as const;

const ALERT_SUMMARY = {
  id: true,
  title: true,
  type: true,
  source: true,
  sourceRef: true,
  severity: true,
  stage: true,
  caseId: true,
  date: true,
} as const;

/** One comparable observable per dataHash (ignoreSimilarity observables never take part). */
function comparableByHash(observables: any[]): Map<string, any> {
  const byHash = new Map<string, any>();
  for (const observable of observables || []) {
    if (!observable?.dataHash || observable.ignoreSimilarity) continue;
    const current = byHash.get(observable.dataHash);
    if (!current || (!current.ioc && observable.ioc) || (!current.sighted && observable.sighted)) {
      byHash.set(observable.dataHash, observable);
    }
  }
  return byHash;
}

function caseView(item: any) {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    severity: item.severity,
    stage: item.stage,
    status: item.status?.value ?? item.stage,
    closed: item.stage === 'Closed' || !!item.closedAt,
    closedAt: item.closedAt,
  };
}

function alertView(item: any) {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    source: item.source,
    sourceRef: item.sourceRef,
    severity: item.severity,
    stage: item.stage,
    caseId: item.caseId,
    date: item.date,
  };
}

function sharedList(shared: Map<string, any>) {
  return [...shared.values()].map((observable) => ({
    dataType: observable.dataType,
    data: observable.data,
    ioc: !!observable.ioc,
  }));
}

@Injectable()
export class CorrelationService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- public API

  async relatedCases(user: AuthUser, caseId: string) {
    const current = await this.prisma.case.findFirst({
      where: { id: caseId, organisationId: user.organisationId },
      select: { id: true },
    });
    if (!current) throw new NotFoundException('Case not found');

    const own = await this.prisma.observable.findMany({
      where: { organisationId: user.organisationId, caseId, dataHash: { not: null }, ignoreSimilarity: false },
      select: { dataHash: true, dataType: true, data: true, ioc: true },
    });
    const ownHashes = [...comparableByHash(own).keys()];
    if (!ownHashes.length) return [];

    const groups = await this.caseGroups(user.organisationId, ownHashes, caseId);
    return groups
      .sort((a, b) => b.shared.size - a.shared.size || b.item.createdAt.getTime() - a.item.createdAt.getTime())
      .slice(0, 50)
      .map((group) => ({
        case: caseView(group.item),
        sharedCount: group.shared.size,
        sharedObservables: sharedList(group.shared),
        ratio: ownHashes.length ? group.shared.size / ownHashes.length : 0,
      }));
  }

  async similarForAlert(user: AuthUser, alertId: string) {
    const alert = await this.prisma.alert.findFirst({
      where: { id: alertId, organisationId: user.organisationId },
      select: { id: true, observables: { select: { dataHash: true, dataType: true, data: true, ioc: true, sighted: true, ignoreSimilarity: true } } },
    });
    if (!alert) throw new NotFoundException('Alert not found');

    const ownHashes = [...comparableByHash(alert.observables).keys()];
    if (!ownHashes.length) return { cases: [], alerts: [] };

    const [cases, alerts] = await Promise.all([
      this.caseGroups(user.organisationId, ownHashes),
      this.alertGroups(user.organisationId, ownHashes, alertId),
    ]);

    return {
      cases: cases
        .sort((a, b) => b.shared.size - a.shared.size || b.item.createdAt.getTime() - a.item.createdAt.getTime())
        .slice(0, 50)
        .map((group) => ({
          case: caseView(group.item),
          sharedCount: group.shared.size,
          observableCount: ownHashes.length,
          similarIocCount: group.iocCount,
          sharedObservables: sharedList(group.shared),
          ratio: group.shared.size / ownHashes.length,
        })),
      alerts: alerts
        .sort((a, b) => b.shared.size - a.shared.size || b.item.date.getTime() - a.item.date.getTime())
        .slice(0, 50)
        .map((group) => ({
          alert: alertView(group.item),
          sharedCount: group.shared.size,
          observableCount: ownHashes.length,
          similarIocCount: group.iocCount,
          sharedObservables: sharedList(group.shared),
          ratio: group.shared.size / ownHashes.length,
        })),
    };
  }

  async sightings(user: AuthUser, observableId: string) {
    const current = await this.prisma.observable.findFirst({
      where: { id: observableId, organisationId: user.organisationId },
      select: { id: true, dataHash: true, ignoreSimilarity: true, caseId: true, alertId: true },
    });
    if (!current) throw new NotFoundException('Observable not found');
    if (!current.dataHash || current.ignoreSimilarity) return [];

    const rows = await this.prisma.observable.findMany({
      where: {
        organisationId: user.organisationId,
        dataHash: current.dataHash,
        ignoreSimilarity: false,
        id: { not: current.id },
      },
      select: {
        id: true,
        dataType: true,
        data: true,
        ioc: true,
        sighted: true,
        caseId: true,
        alertId: true,
        case: { select: { id: true, number: true, title: true, stage: true, createdAt: true, mergedIntoCaseId: true } },
        alert: { select: { id: true, title: true, stage: true, date: true } },
      },
    });

    const found = new Map<string, any>();
    const remember = (key: string, entry: any) => {
      const existing = found.get(key);
      if (!existing) {
        found.set(key, entry);
        return;
      }
      existing.ioc = existing.ioc || entry.ioc;
      existing.sighted = existing.sighted || entry.sighted;
    };

    for (const row of rows) {
      if (row.case && row.caseId !== current.caseId && !row.case.mergedIntoCaseId) {
        remember(`case:${row.case.id}`, {
          kind: 'case',
          id: row.case.id,
          number: row.case.number,
          title: row.case.title,
          stage: row.case.stage,
          date: row.case.createdAt,
          observableId: row.id,
          ioc: !!row.ioc,
          sighted: !!row.sighted,
        });
      }
      if (row.alert && row.alertId !== current.alertId) {
        remember(`alert:${row.alert.id}`, {
          kind: 'alert',
          id: row.alert.id,
          title: row.alert.title,
          stage: row.alert.stage,
          date: row.alert.date,
          observableId: row.id,
          ioc: !!row.ioc,
          sighted: !!row.sighted,
        });
      }
    }

    return [...found.values()].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  /** id → number of other cases/alerts containing the same dataHash. */
  async seenCounts(user: AuthUser, observableIds: string[]): Promise<Record<string, number>> {
    const ids = [...new Set((observableIds || []).filter(Boolean))];
    const result: Record<string, number> = {};
    for (const id of ids) result[id] = 0;
    if (!ids.length) return result;

    const sources = await this.prisma.observable.findMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      select: { id: true, dataHash: true, ignoreSimilarity: true, caseId: true, alertId: true },
    });
    const hashes = [...new Set(sources.filter((row) => row.dataHash && !row.ignoreSimilarity).map((row) => row.dataHash))];
    if (!hashes.length) return result;

    const rows = await this.prisma.observable.findMany({
      where: { organisationId: user.organisationId, dataHash: { in: hashes }, ignoreSimilarity: false },
      select: { dataHash: true, caseId: true, alertId: true },
    });
    const byHash = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!byHash.has(row.dataHash)) byHash.set(row.dataHash, new Set());
      const set = byHash.get(row.dataHash);
      if (row.caseId) set.add(`case:${row.caseId}`);
      if (row.alertId) set.add(`alert:${row.alertId}`);
    }

    for (const source of sources) {
      if (!source.dataHash || source.ignoreSimilarity) continue;
      const set = byHash.get(source.dataHash);
      if (!set) continue;
      let count = set.size;
      if (source.caseId && set.has(`case:${source.caseId}`)) count--;
      if (source.alertId && set.has(`alert:${source.alertId}`)) count--;
      result[source.id] = Math.max(0, count);
    }
    return result;
  }

  /** Alert list helper: number of similar open cases per alert, in batch. */
  async similarCaseCounts(user: AuthUser, alertIds: string[]): Promise<Record<string, number>> {
    const ids = [...new Set((alertIds || []).filter(Boolean))];
    const result: Record<string, number> = {};
    for (const id of ids) result[id] = 0;
    if (!ids.length) return result;

    const alerts = await this.prisma.alert.findMany({
      where: { id: { in: ids }, organisationId: user.organisationId },
      select: {
        id: true,
        caseId: true,
        observables: { select: { dataHash: true, ignoreSimilarity: true } },
      },
    });
    const hashesByAlert = new Map<string, string[]>();
    const hashes = new Set<string>();
    for (const alert of alerts) {
      const own = [...comparableByHash(alert.observables).keys()];
      hashesByAlert.set(alert.id, own);
      for (const hash of own) hashes.add(hash);
    }
    if (!hashes.size) return result;

    const caseRows = await this.prisma.observable.findMany({
      where: {
        organisationId: user.organisationId,
        dataHash: { in: [...hashes] },
        ignoreSimilarity: false,
        caseId: { not: null },
      },
      select: {
        dataHash: true,
        caseId: true,
        case: { select: { id: true, stage: true, closedAt: true, mergedIntoCaseId: true } },
      },
    });
    const openCasesByHash = new Map<string, Set<string>>();
    for (const row of caseRows) {
      if (!row.caseId || !row.case || row.case.mergedIntoCaseId) continue;
      if (row.case.stage === 'Closed' || row.case.closedAt) continue;
      if (!openCasesByHash.has(row.dataHash)) openCasesByHash.set(row.dataHash, new Set());
      openCasesByHash.get(row.dataHash).add(row.caseId);
    }

    for (const alert of alerts) {
      const cases = new Set<string>();
      for (const hash of hashesByAlert.get(alert.id) || []) {
        for (const caseId of openCasesByHash.get(hash) || []) {
          if (caseId !== alert.caseId) cases.add(caseId);
        }
      }
      result[alert.id] = cases.size;
    }
    return result;
  }

  // ---------------------------------------------------------------- Query API support

  /** Cases similar to an alert or a case, plus the counters TheHive 5 exposes in extraData. */
  async similarCasesForQuery(user: AuthUser, model: string, id: string) {
    let ownHashes: string[] = [];
    let excludeCaseId: string | undefined;
    if (model === 'alert') {
      const alert = await this.prisma.alert.findFirst({
        where: { id, organisationId: user.organisationId },
        select: { id: true, observables: { select: { dataHash: true, dataType: true, data: true, ioc: true, sighted: true, ignoreSimilarity: true } } },
      });
      if (!alert) throw new NotFoundException('Alert not found');
      ownHashes = [...comparableByHash(alert.observables).keys()];
    } else if (model === 'case') {
      const item = await this.prisma.case.findFirst({
        where: { id, organisationId: user.organisationId },
        select: { id: true, observables: { select: { dataHash: true, dataType: true, data: true, ioc: true, sighted: true, ignoreSimilarity: true } } },
      });
      if (!item) throw new NotFoundException('Case not found');
      ownHashes = [...comparableByHash(item.observables).keys()];
      excludeCaseId = id;
    }
    if (!ownHashes.length) return { ids: [] as string[], counters: new Map<string, any>() };

    const groups = await this.caseGroups(user.organisationId, ownHashes, excludeCaseId);
    groups.sort((a, b) => b.shared.size - a.shared.size || b.item.createdAt.getTime() - a.item.createdAt.getTime());
    const counters = new Map<string, any>();
    for (const group of groups.slice(0, 50)) {
      const data = {
        similarObservableCount: group.shared.size,
        observableCount: ownHashes.length,
        similarIocCount: group.iocCount,
        sharedObservableCount: group.shared.size,
        ratio: group.shared.size / ownHashes.length,
      };
      counters.set(group.item.id, { ...data, extraData: data });
    }
    return { ids: [...counters.keys()], counters };
  }

  async similarAlertsForQuery(user: AuthUser, model: string, id: string) {
    let ownHashes: string[] = [];
    let excludeAlertId: string | undefined;
    if (model === 'alert') {
      const alert = await this.prisma.alert.findFirst({
        where: { id, organisationId: user.organisationId },
        select: { id: true, observables: { select: { dataHash: true, dataType: true, data: true, ioc: true, sighted: true, ignoreSimilarity: true } } },
      });
      if (!alert) throw new NotFoundException('Alert not found');
      ownHashes = [...comparableByHash(alert.observables).keys()];
      excludeAlertId = id;
    } else if (model === 'case') {
      const item = await this.prisma.case.findFirst({
        where: { id, organisationId: user.organisationId },
        select: { id: true, observables: { select: { dataHash: true, dataType: true, data: true, ioc: true, sighted: true, ignoreSimilarity: true } } },
      });
      if (!item) throw new NotFoundException('Case not found');
      ownHashes = [...comparableByHash(item.observables).keys()];
    }
    if (!ownHashes.length) return { ids: [] as string[], counters: new Map<string, any>() };

    const groups = await this.alertGroups(user.organisationId, ownHashes, excludeAlertId);
    groups.sort((a, b) => b.shared.size - a.shared.size || b.item.date.getTime() - a.item.date.getTime());
    const counters = new Map<string, any>();
    for (const group of groups.slice(0, 50)) {
      const data = {
        similarObservableCount: group.shared.size,
        observableCount: ownHashes.length,
        similarIocCount: group.iocCount,
        sharedObservableCount: group.shared.size,
        ratio: group.shared.size / ownHashes.length,
      };
      counters.set(group.item.id, { ...data, extraData: data });
    }
    return { ids: [...counters.keys()], counters };
  }

  // ---------------------------------------------------------------- internals

  private async caseGroups(organisationId: string, hashes: string[], excludeCaseId?: string) {
    const rows = await this.prisma.observable.findMany({
      where: {
        organisationId,
        dataHash: { in: hashes },
        ignoreSimilarity: false,
        caseId: { not: null },
      },
      select: {
        dataHash: true,
        dataType: true,
        data: true,
        ioc: true,
        caseId: true,
        case: { select: CASE_SUMMARY },
      },
    });

    const groups = new Map<string, { item: any; shared: Map<string, any>; ioc: Set<string> }>();
    for (const row of rows) {
      if (!row.caseId || !row.case || row.case.mergedIntoCaseId) continue;
      if (excludeCaseId && row.caseId === excludeCaseId) continue;
      if (!groups.has(row.caseId)) groups.set(row.caseId, { item: row.case, shared: new Map(), ioc: new Set() });
      const group = groups.get(row.caseId);
      const existing = group.shared.get(row.dataHash);
      if (!existing) group.shared.set(row.dataHash, { dataType: row.dataType, data: row.data, ioc: !!row.ioc });
      else if (row.ioc) existing.ioc = true;
      if (row.ioc) group.ioc.add(row.dataHash);
    }

    return [...groups.values()].map((group) => ({
      ...group,
      iocCount: group.ioc.size,
    }));
  }

  private async alertGroups(organisationId: string, hashes: string[], excludeAlertId?: string) {
    const rows = await this.prisma.observable.findMany({
      where: {
        organisationId,
        dataHash: { in: hashes },
        ignoreSimilarity: false,
        alertId: { not: null },
      },
      select: {
        dataHash: true,
        dataType: true,
        data: true,
        ioc: true,
        alertId: true,
        alert: { select: ALERT_SUMMARY },
      },
    });

    const groups = new Map<string, { item: any; shared: Map<string, any>; ioc: Set<string> }>();
    for (const row of rows) {
      if (!row.alertId || !row.alert) continue;
      if (excludeAlertId && row.alertId === excludeAlertId) continue;
      if (!groups.has(row.alertId)) groups.set(row.alertId, { item: row.alert, shared: new Map(), ioc: new Set() });
      const group = groups.get(row.alertId);
      const existing = group.shared.get(row.dataHash);
      if (!existing) group.shared.set(row.dataHash, { dataType: row.dataType, data: row.data, ioc: !!row.ioc });
      else if (row.ioc) existing.ioc = true;
      if (row.ioc) group.ioc.add(row.dataHash);
    }

    return [...groups.values()].map((group) => ({
      ...group,
      iocCount: group.ioc.size,
    }));
  }
}
