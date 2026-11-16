#!/usr/bin/env node
// Sincroniza el esquema Prisma de forma segura al arrancar / actualizar MyHive.
//
// 1. Ejecuta pasos previos idempotentes (SQL) para que `prisma db push` no se
//    detenga pidiendo --accept-data-loss. Nunca se usa --accept-data-loss.
// 2. Ejecuta `prisma db push --skip-generate`.
//
// Pasos previos conocidos desde b35c77f (base desplegada en la VM):
//   - Function: se añadió @@unique([organisationId, name]). Se renombran los
//     duplicados (el más antiguo se conserva) y se crea el índice único.
//   - SlaEvent y Tactic son tablas nuevas: db push las crea sin conflicto.
//   - Pattern conserva su @unique(patternId) original.
// Cualquier nuevo @@unique/@unique sobre una tabla existente debe añadirse aquí.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.prisma', import.meta.url));

const log = (...args) => console.log('[db-sync]', ...args);
const prisma = new PrismaClient();

async function tableExists(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1`,
    table,
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1`,
    table,
    column,
  );
  return rows.length > 0;
}

async function uniqueIndexExists(table, columns) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = $1`,
    table,
  );
  return rows.some(({ indexdef }) => {
    if (!/CREATE UNIQUE INDEX/i.test(indexdef)) return false;
    const match = indexdef.match(/USING \w+ \(([^)]+)\)/i);
    if (!match) return false;
    const indexed = match[1]
      .split(',')
      .map((col) => col.trim().replace(/^"|"$/g, '').replace(/\s+(ASC|DESC)$/i, ''));
    return columns.every((col, i) => indexed[i] === col) && indexed.length === columns.length;
  });
}

async function ensureFunctionUnique() {
  if (!(await tableExists('Function'))) {
    log('Function: tabla nueva, db push la creará');
    return;
  }
  if (await uniqueIndexExists('Function', ['organisationId', 'name'])) {
    log('Function: índice único (organisationId, name) ya existe');
    return;
  }

  const duplicates = await prisma.$queryRawUnsafe(
    `SELECT "organisationId", name, count(*)::int AS n
       FROM "Function" GROUP BY 1, 2 HAVING count(*) > 1`,
  );

  let renamed = 0;
  for (const dup of duplicates) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM "Function"
        WHERE "organisationId" = $1 AND name = $2
        ORDER BY "createdAt" ASC, id ASC`,
      dup.organisationId,
      dup.name,
    );
    // El primero (el más antiguo) conserva el nombre original.
    for (let i = 1; i < rows.length; i += 1) {
      let suffix = 2;
      let candidate;
      for (;;) {
        candidate = `${dup.name}-${suffix}`;
        const clash = await prisma.$queryRawUnsafe(
          `SELECT 1 FROM "Function" WHERE "organisationId" = $1 AND name = $2 LIMIT 1`,
          dup.organisationId,
          candidate,
        );
        if (clash.length === 0) break;
        suffix += 1;
      }
      await prisma.$executeRawUnsafe(`UPDATE "Function" SET name = $1 WHERE id = $2`, candidate, rows[i].id);
      renamed += 1;
      log(`Function: "${dup.name}" duplicada en org ${dup.organisationId} → "${candidate}"`);
    }
  }

  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "Function_organisationId_name_key"
       ON "Function" ("organisationId", name)`,
  );
  log(`Function: índice único creado (${renamed} fila(s) renombrada(s))`);
}

async function preSteps() {
  // Registro de pasos previos. Todos deben ser no-op en bases nuevas o ya migradas.
  await ensureFunctionUnique();

  // Comprobación informativa de columnas nuevas con valor por defecto.
  const checks = [
    ['Function', 'kind'],
    ['Function', 'mode'],
    ['Page', 'caseId'],
    ['Observable', 'attachmentId'],
  ];
  for (const [table, column] of checks) {
    if (await tableExists(table)) {
      const exists = await columnExists(table, column);
      log(`${table}.${column}: ${exists ? 'presente' : 'la añadirá db push'}`);
    }
  }
}

function runPush() {
  log('Ejecutando prisma db push --skip-generate (sin --accept-data-loss)');
  const result = spawnSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--schema', SCHEMA_PATH], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error('[db-sync] No se pudo ejecutar prisma:', result.error.message);
    return 1;
  }
  if (result.status !== 0) {
    console.error('');
    console.error('[db-sync] prisma db push falló. No se usa --accept-data-loss a propósito.');
    console.error('[db-sync] Revisa el mensaje de Prisma: si pide aceptar pérdida de datos por una');
    console.error('[db-sync] restricción única nueva, añade un paso previo en prisma/db-sync.mjs');
    console.error('[db-sync] (renombrar duplicados) en lugar de aceptar cambios destructivos.');
    return result.status ?? 1;
  }
  log('Esquema sincronizado correctamente');
  return 0;
}

async function main() {
  try {
    await preSteps();
  } catch (error) {
    console.error('[db-sync] Error en los pasos previos:', error?.message || error);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  return runPush();
}

process.exitCode = await main();
