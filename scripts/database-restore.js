#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');
const { validateDatabase, writeBackup } = require('./database-backup');

function requireStoppedDeclaration(argv) {
  if (!argv.includes('--confirm-stopped')) throw new Error('Restore requires --confirm-stopped after stopping the web app and notification worker.');
  const paths = argv.filter((arg) => arg !== '--confirm-stopped');
  if (paths.length !== 1 || paths[0].startsWith('-')) throw new Error('Usage: npm run db:restore -- <source.sqlite> --confirm-stopped');
  return path.resolve(paths[0]);
}

async function restoreDatabase(sourcePath, targetPath, { confirmStopped = false } = {}) {
  if (!confirmStopped) throw new Error('Restore requires an explicit stopped-app declaration.');
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source.toLowerCase() === target.toLowerCase()) throw new Error('Restore source and target must be different files.');
  validateDatabase(source);
  if (!fs.existsSync(target)) throw new Error(`Restore target does not exist: ${target}`);

  const directory = path.dirname(target);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyPath = `${target}.pre-restore-${stamp}`;
  const stagedPath = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.restore`);
  await writeBackup(target, safetyPath);
  try {
    const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await sourceDb.backup(stagedPath);
    } finally {
      sourceDb.close();
    }
    validateDatabase(stagedPath);

    // A confirmed stopped app has no live SQLite handles. Rename on the same volume
    // keeps the staged database replacement atomic and makes rollback possible.
    const displacedPath = `${target}.restore-rollback-${stamp}`;
    fs.renameSync(target, displacedPath);
    try {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${target}${suffix}`;
        if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${displacedPath}${suffix}`);
      }
      fs.renameSync(stagedPath, target);
    } catch (error) {
      for (const suffix of ['-wal', '-shm']) {
        const displacedSidecar = `${displacedPath}${suffix}`;
        if (!fs.existsSync(`${target}${suffix}`) && fs.existsSync(displacedSidecar)) {
          fs.renameSync(displacedSidecar, `${target}${suffix}`);
        }
      }
      if (!fs.existsSync(target) && fs.existsSync(displacedPath)) fs.renameSync(displacedPath, target);
      throw error;
    }
    return { target, safetyPath, schemaVersion: validateDatabase(target).schemaVersion };
  } finally {
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  }
}

async function main() {
  const source = requireStoppedDeclaration(process.argv.slice(2));
  const config = loadConfig();
  const result = await restoreDatabase(source, config.dbPath, { confirmStopped: true });
  console.log(`Database restored and verified at ${result.target} (schema ${result.schemaVersion}). Safety backup: ${result.safetyPath}`);
}

if (require.main === module) main().catch((error) => {
  console.error(`Database restore failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { requireStoppedDeclaration, restoreDatabase };
