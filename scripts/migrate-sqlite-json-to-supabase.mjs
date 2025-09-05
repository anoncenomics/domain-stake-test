#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';

const { Pool } = pg;

const argv = process.argv.slice(2);

function getArg(key, defaultValue) {
  const i = argv.indexOf(`--${key}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[key.toUpperCase()] ?? defaultValue;
}

const SQLITE_PATH = getArg('sqlite', 'public/data/comprehensive-metrics.db');
const FROM = getArg('from');
const TO = getArg('to', 'all');

const PG_HOST = getArg('pg-host', process.env.PG_HOST || 'localhost');
const PG_PORT = Number(getArg('pg-port', process.env.PG_PORT || '5432'));
const PG_NAME = getArg('pg-name', process.env.PG_NAME || 'postgres');
const PG_USER = getArg('pg-user', process.env.PG_USER || 'postgres');
const PG_PASS = getArg('pg-pass', process.env.PG_PASS || process.env.PG_PASSWORD || '');

const DRY_RUN = argv.includes('--dry-run');
const VALIDATE = argv.includes('--validate');

class SqliteReader {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`SQLite database not found: ${this.dbPath}`);
    }
    this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
    console.log(`[sqlite] Connected to ${this.dbPath}`);
  }

  async getEpochRange() {
    const row = await this.db.get('SELECT MIN(epoch) AS min_epoch, MAX(epoch) AS max_epoch FROM epochs');
    return { minEpoch: row?.min_epoch ?? null, maxEpoch: row?.max_epoch ?? null };
  }

  async getEpochs(fromEpoch, toEpoch) {
    const params = [];
    let sql = 'SELECT epoch, end_block, end_hash, timestamp, data FROM epochs WHERE 1=1';
    if (fromEpoch != null) { sql += ' AND epoch >= ?'; params.push(fromEpoch); }
    if (toEpoch != null) { sql += ' AND epoch <= ?'; params.push(toEpoch); }
    sql += ' ORDER BY epoch';
    const rows = await this.db.all(sql, params);
    return rows;
  }

  async close() { if (this.db) await this.db.close(); }
}

class SupabaseJsonWriter {
  constructor(config) {
    this.pool = new Pool(config);
  }

  async initialize() {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT version()');
      console.log(`[postgres] Connected: ${res.rows[0].version.split(' ')[0]}`);
      // Ensure epochs table has expected columns
      const check = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='epochs' ORDER BY ordinal_position"
      );
      const cols = check.rows.map(r => r.column_name);
      const required = ['epoch','end_block','end_hash','timestamp','data'];
      for (const c of required) {
        if (!cols.includes(c)) {
          throw new Error(`Supabase 'epochs' missing required column: ${c}`);
        }
      }
      console.log(`[schema] epochs columns OK: ${cols.join(', ')}`);
    } finally {
      client.release();
    }
  }

  async insertEpoch(epochRow) {
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO epochs (epoch, end_block, end_hash, timestamp, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (epoch) DO UPDATE SET end_block = EXCLUDED.end_block, end_hash = EXCLUDED.end_hash, timestamp = EXCLUDED.timestamp, data = EXCLUDED.data',
        [epochRow.epoch, epochRow.end_block, epochRow.end_hash, epochRow.timestamp, epochRow.data]
      );
    } finally {
      client.release();
    }
  }

  async getExistingEpochs(fromEpoch, toEpoch) {
    const client = await this.pool.connect();
    try {
      const params = [];
      let sql = 'SELECT epoch FROM epochs WHERE 1=1';
      if (fromEpoch != null) { sql += ' AND epoch >= $' + (params.push(fromEpoch)); }
      if (toEpoch != null) { sql += ' AND epoch <= $' + (params.push(toEpoch)); }
      const res = await client.query(sql, params);
      return new Set(res.rows.map(r => r.epoch));
    } finally {
      client.release();
    }
  }

  async refreshMaterializedView() {
    const client = await this.pool.connect();
    try {
      await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY comprehensive_analytics');
      console.log('[refresh] comprehensive_analytics refreshed');
    } catch (e) {
      console.warn(`[refresh] concurrent refresh failed, retrying non-concurrent: ${e.message}`);
      await client.query('REFRESH MATERIALIZED VIEW comprehensive_analytics');
      console.log('[refresh] comprehensive_analytics refreshed (non-concurrent)');
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

async function main() {
  console.log('[migrate-json] SQLite → Supabase (epochs.data JSONB)');
  console.log(`[migrate-json] sqlite=${SQLITE_PATH}`);
  console.log(`[migrate-json] target=${PG_HOST}:${PG_PORT}/${PG_NAME} user=${PG_USER}`);

  let sqlite, writer;
  try {
    sqlite = new SqliteReader(SQLITE_PATH);
    await sqlite.initialize();

    const { minEpoch, maxEpoch } = await sqlite.getEpochRange();
    if (minEpoch == null) { console.log('[migrate-json] No rows in SQLite'); return; }
    const fromEpoch = FROM ? Number(FROM) : minEpoch;
    const toEpoch = TO === 'all' ? maxEpoch : Number(TO);
    console.log(`[migrate-json] range ${fromEpoch}..${toEpoch}`);

    if (DRY_RUN) {
      const count = (await sqlite.getEpochs(fromEpoch, toEpoch)).length;
      console.log(`[dry-run] would migrate ${count} epochs`);
      return;
    }

    writer = new SupabaseJsonWriter({ host: PG_HOST, port: PG_PORT, database: PG_NAME, user: PG_USER, password: PG_PASS, max: 10 });
    await writer.initialize();

    const existing = await writer.getExistingEpochs(fromEpoch, toEpoch);
    const rows = await sqlite.getEpochs(fromEpoch, toEpoch);
    console.log(`[migrate-json] epochs to process: ${rows.length} (existing in target: ${existing.size})`);

    let migrated = 0; let skipped = 0;
    for (const row of rows) {
      if (existing.has(row.epoch)) { skipped++; continue; }
      await writer.insertEpoch(row);
      migrated++;
      if (migrated % 100 === 0) console.log(`[migrate-json] migrated=${migrated}`);
    }
    console.log(`[migrate-json] complete migrated=${migrated} skipped=${skipped}`);

    if (VALIDATE) {
      console.log('[validate] refreshing comprehensive_analytics');
      await writer.refreshMaterializedView();
    }

  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  } finally {
    if (sqlite) await sqlite.close();
    if (writer) await writer.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });


