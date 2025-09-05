#!/usr/bin/env node

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const argv = process.argv.slice(2);

function getArg(key, def){
  const i = argv.indexOf(`--${key}`);
  if (i !== -1 && argv[i+1] && !argv[i+1].startsWith('--')) return argv[i+1];
  return def;
}

const DB_PATH = getArg('db', 'public/data/comprehensive-metrics.db');
const FROM = Number(getArg('from', '2651'));

async function main(){
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  try {
    const { m: max } = await db.get('SELECT MAX(epoch) m FROM epochs');
    const rows = await db.all('SELECT epoch FROM epochs WHERE epoch >= ? ORDER BY epoch', FROM);
    const have = new Set(rows.map(r => r.epoch));
    const missing = [];
    for (let e = FROM; e <= max; e++) if (!have.has(e)) missing.push(e);
    console.log(JSON.stringify({ from: FROM, max, missingCount: missing.length, missing }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });


