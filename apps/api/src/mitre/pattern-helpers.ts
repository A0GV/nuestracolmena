import { PrismaService } from '../prisma/prisma.service';

export interface ProcedurePatternInput {
  patternId?: string | null;
  patternName?: string | null;
  tactic?: string | null;
}

/**
 * Fills a procedure's display fields from the ATT&CK catalog.
 *
 * `patternName` is only replaced when it is empty or a placeholder (the id), so
 * analyst-provided names survive. `tactic` is filled when the technique has
 * exactly one tactic and the caller did not provide one; techniques with more
 * than one tactic stay null (the analyst must pick).
 */
export function applyPatternToProcedure<T extends ProcedurePatternInput>(input: T, pattern: any): T {
  if (!pattern) return input;
  const placeholder = !input.patternName || input.patternName === input.patternId;
  const patternName = placeholder ? pattern.name : input.patternName;
  const tactic = input.tactic || (Array.isArray(pattern.tactics) && pattern.tactics.length === 1 ? pattern.tactics[0] : null);
  return { ...input, patternName, tactic };
}

/**
 * Tactics are stored with their full display name (`Initial Access`), but the
 * UI and imported data may use the ATT&CK short name (`initial-access`).
 */
async function resolveTacticNames(prisma: PrismaService, values: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(values.filter(Boolean)));
  const resolved = new Map<string, string>();
  if (!unique.length) return resolved;
  const tactics = await prisma.tactic
    .findMany({
      where: {
        OR: [
          { name: { in: unique } },
          { shortName: { in: unique } },
          { tacticId: { in: unique } },
        ],
      },
      select: { name: true, shortName: true, tacticId: true },
    })
    .catch(() => [] as Array<{ name: string; shortName: string; tacticId: string }>);
  for (const tactic of tactics) {
    resolved.set(tactic.name, tactic.name);
    resolved.set(tactic.shortName, tactic.name);
    resolved.set(tactic.tacticId, tactic.name);
  }
  return resolved;
}

export async function enrichProcedureInput(prisma: PrismaService, input: any) {
  if (!input?.patternId) return input;
  const pattern = await prisma.pattern.findUnique({ where: { patternId: String(input.patternId) } }).catch(() => null);
  const enriched = pattern ? applyPatternToProcedure(input, pattern) : input;
  if (!enriched?.tactic) return enriched;
  const tactics = await resolveTacticNames(prisma, [String(enriched.tactic)]);
  return { ...enriched, tactic: tactics.get(String(enriched.tactic)) || enriched.tactic };
}

export async function enrichProcedures(prisma: PrismaService, procedures: any[]) {
  if (!Array.isArray(procedures) || procedures.length === 0) return procedures;
  const ids = Array.from(new Set(procedures.map((item) => item?.patternId).filter(Boolean).map(String)));
  if (!ids.length) return procedures;
  const patterns = await prisma.pattern.findMany({ where: { patternId: { in: ids } } });
  const byPatternId = new Map(patterns.map((pattern) => [pattern.patternId, pattern]));
  const enriched = procedures.map((item) => {
    const pattern = byPatternId.get(item?.patternId);
    return pattern ? applyPatternToProcedure(item, pattern) : item;
  });
  const tacticValues = enriched
    .map((item) => (item?.tactic ? String(item.tactic) : ''))
    .filter(Boolean);
  const tactics = await resolveTacticNames(prisma, tacticValues);
  return enriched.map((item) => (
    item?.tactic && tactics.has(String(item.tactic))
      ? { ...item, tactic: tactics.get(String(item.tactic)) }
      : item
  ));
}

/** Attaches `pattern: { patternId, name, tactics, url }` to procedure rows for TheHive-shaped output. */
export async function attachPatterns(prisma: PrismaService, procedures: any[]) {
  if (!Array.isArray(procedures) || procedures.length === 0) return procedures;
  const ids = Array.from(new Set(procedures.map((item) => item?.patternId).filter(Boolean).map(String)));
  if (!ids.length) return procedures;
  const patterns = await prisma.pattern.findMany({ where: { patternId: { in: ids } } });
  const byPatternId = new Map(patterns.map((pattern) => [pattern.patternId, pattern]));
  return procedures.map((item) => {
    const pattern = byPatternId.get(item?.patternId);
    if (!pattern) return item;
    return {
      ...item,
      pattern: {
        patternId: pattern.patternId,
        name: pattern.name,
        tactics: pattern.tactics || [],
        url: pattern.url,
      },
    };
  });
}
