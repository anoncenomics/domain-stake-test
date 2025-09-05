#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';

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

function main(){
  console.log(`[monitor] start`);

  // 1) Backfill latest epochs into SQLite (resume from last)
  console.log(`[monitor] backfill → SQLite`);
  run('node', [
    path.join('scripts', 'optimized-comprehensive-backfill.mjs'),
    '--ws', WS,
    '--domain', String(DOMAIN_ID),
    '--db', SQLITE_DB,
    '--concurrency', String(CONCURRENCY),
    '--batch-size', String(BATCH_SIZE),
    '--resume'
  ]);

  // 2) Find Supabase max epoch
  console.log(`[monitor] migrate → Supabase`);
  // We migrate from the current Supabase MAX(epoch)+1 to SQLite MAX(epoch)
  // The migrate script will skip existing epochs anyway, but this keeps it lean
  run('node', [
    path.join('scripts', 'migrate-sqlite-json-to-supabase.mjs'),
    '--sqlite', SQLITE_DB,
    '--from', String(Number(process.env.FROM || 0)), // optional override; otherwise full range
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


