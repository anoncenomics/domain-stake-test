import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Broaden the comprehensive metrics DB by normalizing all `.entries` arrays
// from the JSON `data` column in `epochs` into child tables.
//
// Usage examples:
//   node broaden-db.mjs --db public/data/comprehensive-metrics-full.db
//   node broaden-db.mjs --db public/data/comprehensive-metrics-full.db --drop
//   node broaden-db.mjs --db public/data/comprehensive-metrics-full.db --collections operators,deposits --create-indices=false

const argv = process.argv.slice(2);

function getArg(key, defaultValue) {
  const flag = `--${key}`;
  const index = argv.indexOf(flag);
  if (index !== -1) {
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) return next;
    return true; // boolean flags like --drop
  }
  return defaultValue;
}

const DB_PATH = getArg('db', 'public/data/comprehensive-metrics-full.db');
const DROP_TABLES = Boolean(getArg('drop', false));
const COLLECTIONS_ARG = getArg('collections', '');
const CREATE_INDICES = getArg('create-indices', 'true') !== 'false';
const LIMIT = getArg('limit'); // optional numeric limit for debugging

// Known collections that contain `.entries` with { key: string[]|any[], value: string }
// Keep this list aligned with backfill-local-full.mjs mapToArray usage
const DEFAULT_COLLECTIONS = [
  'deposits',
  'withdrawals',
  'depositOnHold',
  'successfulBundles',
  'operatorEpochSharePrice',
  'operatorHighestSlot',
  'operatorBundleSlot',
  'pendingSlashes',
  'lastEpochStakingDistribution',
  'invalidBundleAuthors',
  'latestConfirmedDomainExecutionReceipt',
  'domainGenesisBlockExecutionReceipt',
  'latestSubmittedER',
  'operators'
];

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeCollectionsArg(arg) {
  if (!arg) return DEFAULT_COLLECTIONS;
  return arg
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getTableName(collectionName) {
  return `${collectionName}_entries`;
}

async function ensureDirectoryFor(filePath) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
}

async function openDatabase(dbPath) {
  await ensureDirectoryFor(dbPath);
  return open({ filename: dbPath, driver: sqlite3.Database });
}

async function dropTablesIfRequested(db, collectionNames) {
  if (!DROP_TABLES) return;
  for (const name of collectionNames) {
    const tableName = getTableName(name);
    await db.exec(`DROP TABLE IF EXISTS ${tableName};`);
  }
}

async function createTables(db, collectionNames) {
  for (const name of collectionNames) {
    const tableName = getTableName(name);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT
      );
    `);
    if (CREATE_INDICES) {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_${tableName}_epoch ON ${tableName}(epoch);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_${tableName}_key ON ${tableName}(key);`);
    }
  }
}

async function prepareStatements(db, collectionNames) {
  const statements = new Map();
  for (const name of collectionNames) {
    const tableName = getTableName(name);
    const stmt = await db.prepare(`INSERT INTO ${tableName} (epoch, key, value) VALUES (?, ?, ?);`);
    statements.set(name, stmt);
  }
  return statements;
}

async function finalizeStatements(statements) {
  for (const stmt of statements.values()) {
    try { await stmt.finalize(); } catch (_) {}
  }
}

function safeParse(jsonText, epoch) {
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    console.warn(`[epoch.${epoch}] Failed to parse data JSON: ${e.message}`);
    return null;
  }
}

function extractEntries(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection; // already array of entries
  if (Array.isArray(collection.entries)) return collection.entries;
  return [];
}

async function insertEntriesForEpoch(db, statements, epochNumber, epochDataObject, collectionNames) {
  for (const name of collectionNames) {
    const entries = extractEntries(epochDataObject[name]);
    if (!entries.length) continue;

    const stmt = statements.get(name);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const keyJson = JSON.stringify(toArray(entry.key));
      const valueText = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      await stmt.run(epochNumber, keyJson, valueText);
    }
  }
}

async function main() {
  console.log(`[broaden-db] db=${DB_PATH}`);

  const collectionNames = normalizeCollectionsArg(COLLECTIONS_ARG);
  console.log(`[broaden-db] collections=${collectionNames.join(',')}`);

  const db = await openDatabase(DB_PATH);

  try {
    await dropTablesIfRequested(db, collectionNames);
    await createTables(db, collectionNames);

    const statements = await prepareStatements(db, collectionNames);
    let processed = 0;
    let insertedByCollection = Object.fromEntries(collectionNames.map(n => [n, 0]));

    const limitClause = LIMIT ? ` LIMIT ${Number(LIMIT)}` : '';
    const rows = await db.all(`SELECT epoch, data FROM epochs ORDER BY epoch${limitClause};`);

    console.log(`[broaden-db] epochs to process: ${rows.length}`);

    await db.exec('BEGIN');
    try {
      for (const row of rows) {
        const epochNumber = row.epoch;
        const obj = safeParse(row.data, epochNumber);
        if (!obj) continue;

        await insertEntriesForEpoch(db, statements, epochNumber, obj, collectionNames);

        processed += 1;
        if (processed % 50 === 0) {
          console.log(`[broaden-db] processed ${processed}/${rows.length} epochs`);
        }
      }
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }

    // Measure counts per table after insert (best-effort)
    for (const name of collectionNames) {
      const tableName = getTableName(name);
      try {
        const { count } = await db.get(`SELECT COUNT(1) as count FROM ${tableName};`);
        insertedByCollection[name] = count;
      } catch (_) {}
    }

    console.log(`[broaden-db] done. epochs processed=${processed}`);
    for (const name of collectionNames) {
      console.log(`[broaden-db] ${getTableName(name)} rows=${insertedByCollection[name]}`);
    }

  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[broaden-db] error: ${err.message}`);
    process.exit(1);
  });
}


