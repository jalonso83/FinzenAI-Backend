import { PrismaClient } from '@prisma/client';
import { merchantMappingService as svc } from './services/merchantMappingService';
const p = new PrismaClient({ datasources: { db: { url: process.env.DB } } });
const APPLY = process.argv.includes('--apply');
(async () => {
  const all = await p.merchantCategoryMapping.findMany({ orderBy: { updatedAt: 'desc' } });
  const groups = new Map<string, typeof all>();
  for (const m of all) {
    const n = svc.normalizeMerchantName(m.merchantName);
    const key = `${m.userId ?? 'GLOBAL'}|${n}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  let renames = 0, deletes = 0, empty = 0;
  for (const [key, rows] of groups) {
    const newName = key.split('|')[1];
    if (!newName) { empty += rows.length; continue; }
    const [keep, ...dups] = rows; // más reciente primero
    if (dups.length) {
      deletes += dups.length;
      if (dups.length && rows.length > 1 && renames + deletes < 40) console.log(`  ${keep.userId ? 'user' : 'GLOBAL'} "${newName}": keep [${keep.merchantName}] drop ${dups.map(d => `[${d.merchantName}]`).join(' ')}`);
      if (APPLY) await p.merchantCategoryMapping.deleteMany({ where: { id: { in: dups.map(d => d.id) } } });
    }
    if (keep.merchantName !== newName) {
      renames++;
      if (APPLY) await p.merchantCategoryMapping.update({ where: { id: keep.id }, data: { merchantName: newName, merchantPattern: svc.generatePattern(newName), timesUsed: rows.reduce((a, r) => a + r.timesUsed, 0) } });
    }
  }
  console.log(`\ntotal=${all.length} grupos=${groups.size} renombrar=${renames} borrar_duplicados=${deletes} nombre_vacio=${empty} ${APPLY ? '(APLICADO)' : '(dry-run)'}`);
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
