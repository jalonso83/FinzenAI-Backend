/**
 * ONE-TIME MIGRATION SCRIPT
 * Encrypts existing plain-text OAuth tokens and email content in the database.
 *
 * Usage: npx ts-node src/scripts/migrateEncryption.ts [--dry-run]
 *
 * --dry-run: Preview what would be encrypted without making changes
 */

import { PrismaClient } from '@prisma/client';
import { encrypt, isEncrypted } from '../utils/encryption';

const prisma = new PrismaClient();
const isDryRun = process.argv.includes('--dry-run');

async function migrateEmailConnections() {
  console.log('\n=== Migrating EmailConnection tokens ===');

  const connections = await prisma.emailConnection.findMany({
    select: { id: true, email: true, accessToken: true, refreshToken: true }
  });

  console.log(`Found ${connections.length} email connections`);

  let migrated = 0;
  let skipped = 0;

  for (const conn of connections) {
    const needsAccessToken = conn.accessToken && !isEncrypted(conn.accessToken);
    const needsRefreshToken = conn.refreshToken && !isEncrypted(conn.refreshToken);

    if (!needsAccessToken && !needsRefreshToken) {
      skipped++;
      continue;
    }

    console.log(`  ${isDryRun ? '[DRY-RUN]' : ''} Encrypting tokens for: ${conn.email} (id: ${conn.id})`);

    if (!isDryRun) {
      await prisma.emailConnection.update({
        where: { id: conn.id },
        data: {
          ...(needsAccessToken && { accessToken: encrypt(conn.accessToken) }),
          ...(needsRefreshToken && { refreshToken: encrypt(conn.refreshToken!) })
        }
      });
    }

    migrated++;
  }

  console.log(`  Migrated: ${migrated}, Already encrypted: ${skipped}`);
}

async function migrateImportedEmails() {
  console.log('\n=== Migrating ImportedBankEmail rawContent ===');

  const emails = await prisma.importedBankEmail.findMany({
    where: { rawContent: { not: null } },
    select: { id: true, subject: true, rawContent: true }
  });

  console.log(`Found ${emails.length} imported emails with rawContent`);

  let migrated = 0;
  let skipped = 0;

  for (const email of emails) {
    if (!email.rawContent || isEncrypted(email.rawContent)) {
      skipped++;
      continue;
    }

    const preview = email.subject?.substring(0, 40) || email.id;
    console.log(`  ${isDryRun ? '[DRY-RUN]' : ''} Encrypting rawContent for: ${preview}`);

    if (!isDryRun) {
      await prisma.importedBankEmail.update({
        where: { id: email.id },
        data: { rawContent: encrypt(email.rawContent) }
      });
    }

    migrated++;
  }

  console.log(`  Migrated: ${migrated}, Already encrypted: ${skipped}`);
}

async function main() {
  console.log('========================================');
  console.log('  AES-256-GCM Encryption Migration');
  console.log(`  Mode: ${isDryRun ? 'DRY-RUN (no changes)' : 'LIVE'}`);
  console.log('========================================');

  try {
    await migrateEmailConnections();
    await migrateImportedEmails();
    console.log('\n✅ Migration complete!');
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
