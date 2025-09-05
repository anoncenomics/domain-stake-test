#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { activate } from '@autonomys/auto-utils';

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const WS = getArg('ws', process.env.RPC_URL_WS || 'wss://rpc.anoncenomics.com/ws');
const DOMAIN_ID = Number(getArg('domain', '0'));
const CONCURRENCY = Number(getArg('concurrency', '8'));
const BATCH_SIZE = Number(getArg('batch-size', '25'));

const SQLITE_DB = getArg('db', 'public/data/comprehensive-metrics.db');

const PG_HOST = getArg('pg-host', process.env.PG_HOST || 'aws-1-us-east-1.pooler.supabase.com');
const PG_PORT = Number(getArg('pg-port', process.env.PG_PORT || '6543'));
const PG_NAME = getArg('pg-name', process.env.PG_NAME || 'postgres');
const PG_USER = getArg('pg-user', process.env.PG_USER || 'postgres');
const PG_PASS = getArg('pg-pass', process.env.PG_PASS || '');

function run(cmd, args, env = {}){
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (res.status !== 0){
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${res.status}`);
  }
}

async function getSupabaseMaxEpoch(){
  const pool = new pg.Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: PG_NAME,
    user: PG_USER,
    password: PG_PASS,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 2000,
    ssl: { rejectUnauthorized: false }
  });
  try {
    const { rows } = await pool.query('SELECT MAX(epoch) AS max_epoch FROM epochs');
    return Number(rows?.[0]?.max_epoch ?? -1);
  } finally {
    await pool.end();
  }
}

async function getFinalizedToEpoch(){
  // Determine a safe upper bound (head epoch - 1)
  const api = await activate({ rpcUrl: WS });
  try {
    const head = await api.rpc.chain.getHeader();
    const at = await api.at(head.hash);
    const opt = await at.query.domains.domainStakingSummary(DOMAIN_ID);
    if (!opt || opt.isNone) return null;
    const s = opt.unwrap();
    const epochRaw = s.currentEpochIndex ?? s.epochIndex ?? s.epoch;
    const headEpoch = typeof epochRaw?.toNumber === 'function' ? epochRaw.toNumber() : Number(epochRaw);
    return Math.max(0, headEpoch - 1);
  } finally {
    try { await api.disconnect(); } catch {}
  }
}

async function main(){
  console.log(`[monitor] start`);

  // Determine from/to using Supabase (avoid reprocessing all epochs)
  const lastSupabaseEpoch = await getSupabaseMaxEpoch();
  const fromEpoch = Math.max(0, (Number.isFinite(lastSupabaseEpoch) ? lastSupabaseEpoch : -1) + 1);
  const toEpoch = await getFinalizedToEpoch();
  if (toEpoch != null && fromEpoch > toEpoch){
    console.log(`[monitor] up-to-date (from=${fromEpoch} > to=${toEpoch})`);
    return;
  }

  // 1) Backfill only missing finalized epochs into SQLite
  console.log(`[monitor] backfill → SQLite (from=${fromEpoch} to=${toEpoch ?? 'current'})`);
  const backfillArgs = [
    path.join('scripts', 'optimized-comprehensive-backfill.mjs'),
    '--ws', WS,
    '--domain', String(DOMAIN_ID),
    '--db', SQLITE_DB,
    '--concurrency', String(CONCURRENCY),
    '--batch-size', String(BATCH_SIZE),
    '--from', String(fromEpoch)
  ];
  if (toEpoch != null) backfillArgs.push('--to', String(toEpoch));
  run('node', backfillArgs);

  // 2) Find Supabase max epoch
  console.log(`[monitor] migrate → Supabase`);
  run('node', [
    path.join('scripts', 'migrate-sqlite-json-to-supabase.mjs'),
    '--sqlite', SQLITE_DB,
    '--from', String(fromEpoch),
    '--to', 'all',
    '--pg-host', PG_HOST,
    '--pg-port', String(PG_PORT),
    '--pg-name', PG_NAME,
    '--pg-user', PG_USER,
    '--pg-pass', PG_PASS,
    '--validate'
  ]);

  console.log(`[monitor] complete`);
}

main();


