#!/usr/bin/env node

import pg from 'pg';

const { Pool } = pg;

const argv = process.argv.slice(2);

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const PG_HOST = getArg('db-host', process.env.PG_HOST || 'localhost');
const PG_PORT = Number(getArg('db-port', process.env.PG_PORT || '5432'));
const PG_NAME = getArg('db-name', process.env.PG_NAME || 'domainstake');
const PG_USER = getArg('db-user', process.env.PG_USER || 'domainstake_user');
const PG_PASS = getArg('db-pass', process.env.PG_PASS || process.env.PG_PASSWORD || '');
const FROM = getArg('from');
const TO = getArg('to');

function toInt(v){
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : 0;
}

async function main(){
  const pool = new Pool({ host: PG_HOST, port: PG_PORT, database: PG_NAME, user: PG_USER, password: PG_PASS });
  const client = await pool.connect();
  try {
    const where = [];
    const params = [];
    if (FROM){ params.push(Number(FROM)); where.push(`epoch >= $${params.length}`); }
    if (TO){ params.push(Number(TO)); where.push(`epoch <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const res = await client.query(`SELECT epoch FROM epochs ${whereSql} ORDER BY epoch` , params);
    console.log(`[repair] epochs=${res.rowCount}`);

    for (const row of res.rows){
      const epoch = row.epoch;
      const f = await client.query(`SELECT total_stake, total_shares FROM epoch_financial_metrics WHERE epoch=$1`, [epoch]);
      const e = await client.query(`SELECT end_hash FROM epochs WHERE epoch=$1`, [epoch]);

      const total_stake = f.rows[0]?.total_stake ?? null;
      const total_shares = f.rows[0]?.total_shares ?? null;
      const end_hash = e.rows[0]?.end_hash ?? null;

      // Update staking summary if missing or zero
      if (total_stake || total_shares){
        const ss = await client.query(`SELECT 1 FROM epoch_staking_summary WHERE epoch=$1`, [epoch]);
        const totalOperators = (await client.query(`SELECT operators_count FROM epoch_collection_counts WHERE epoch=$1`, [epoch])).rows[0]?.operators_count ?? 0;
        if (ss.rowCount === 0){
          await client.query(`INSERT INTO epoch_staking_summary (epoch, current_epoch_index, total_stake, total_shares, total_operators) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (epoch) DO NOTHING`, [epoch, epoch, String(total_stake ?? '0'), String(total_shares ?? '0'), toInt(totalOperators)]);
        } else {
          await client.query(`UPDATE epoch_staking_summary SET current_epoch_index=$2, total_stake=$3, total_shares=$4, total_operators=$5 WHERE epoch=$1`, [epoch, epoch, String(total_stake ?? '0'), String(total_shares ?? '0'), toInt(totalOperators)]);
        }
      }

      // Fill consensus_block_hash if empty
      if (end_hash){
        await client.query(`UPDATE epoch_domain_state SET consensus_block_hash=COALESCE(NULLIF(consensus_block_hash,''), $2) WHERE epoch=$1`, [epoch, end_hash]);
      }
    }

    console.log(`[repair] complete`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
