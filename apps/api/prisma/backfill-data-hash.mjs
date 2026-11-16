#!/usr/bin/env node
// Backfill Observable.dataHash (sha256 of "dataType:lowercase(data)") for legacy rows.
// Usage: node prisma/backfill-data-hash.mjs

import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const observables = await prisma.observable.findMany({
    where: { dataHash: null },
    select: { id: true, dataType: true, data: true },
  });

  let updated = 0;
  for (const observable of observables) {
    const dataHash = createHash('sha256')
      .update(`${observable.dataType}:${String(observable.data).toLowerCase()}`)
      .digest('hex');
    await prisma.observable.update({ where: { id: observable.id }, data: { dataHash } });
    updated++;
  }

  console.log(`Observable dataHash backfill: ${updated} row(s) updated (${observables.length} scanned).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
