#!/usr/bin/env node

import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node backfill-comprehensive-metrics-postgres.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com/ws)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'current' (default: current)
  --db-host <host>     PostgreSQL host (default: localhost)
  --db-port <port>     PostgreSQL port (default: 5432)
  --db-name <name>     PostgreSQL database name (default: domainstake)
  --db-user <user>     PostgreSQL username (default: postgres)
  --db-pass <pass>     PostgreSQL password
  --concurrency <n>    Number of concurrent workers (default: 5)
  --batch-size <n>     Number of epochs to process in each batch (default: 10)
  --retries <n>        Number of retries for failed requests (default: 3)
  --timeout <ms>       Request timeout in milliseconds (default: 30000)
  --resume             Resume from last processed epoch
  --validate           Validate data integrity after backfill
  --rebuild-schema     Drop and recreate all PostgreSQL tables before backfill
  --help, -h           Show this help message

Environment Variables:
  RPC_URL_WS           WebSocket RPC endpoint (overrides --ws)
  RPC_USER             RPC username (overrides --user)
  RPC_PASS             RPC password (overrides --pass)
  DOMAIN               Domain ID (overrides --domain)
  FROM                 Starting epoch (overrides --from)
  TO                   Ending epoch (overrides --to)
  DB_HOST              PostgreSQL host (overrides --db-host)
  DB_PORT              PostgreSQL port (overrides --db-port)
  DB_NAME              Database name (overrides --db-name)
  DB_USER              Database username (overrides --db-user)
  DB_PASS              Database password (overrides --db-pass)
  CONCURRENCY          Number of workers (overrides --concurrency)
  BATCH_SIZE           Batch size (overrides --batch-size)

Examples:
  # Basic backfill
  node backfill-comprehensive-metrics-postgres.mjs --domain 0 --concurrency 10 --batch-size 20

  # Resume interrupted backfill
  node backfill-comprehensive-metrics-postgres.mjs --domain 0 --resume

  # With validation
  node backfill-comprehensive-metrics-postgres.mjs --domain 0 --validate

  # Use environment variables
  export DB_HOST=localhost
  export DB_NAME=domainstake
  export DB_USER=postgres
  export DB_PASS=password
  node backfill-comprehensive-metrics-postgres.mjs --domain 0
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const WS = getArg('ws', process.env.RPC_URL_WS || 'wss://rpc.anoncenomics.com/ws');
const RPC_USER = getArg('user', process.env.RPC_USER || '');
const RPC_PASS = getArg('pass', process.env.RPC_PASS || '');
const DOMAIN_ID = Number(getArg('domain', '0'));
const FROM = getArg('from');
const TO = getArg('to', 'current');
const DB_HOST = getArg('db-host', 'localhost');
const DB_PORT = Number(getArg('db-port', '5432'));
const DB_NAME = getArg('db-name', 'domainstake');
const DB_USER = getArg('db-user', 'domainstake_user');
const DB_PASS = getArg('db-pass', '');
const CONCURRENCY = Number(getArg('concurrency', '5'));
const BATCH_SIZE = Number(getArg('batch-size', '10'));
const RETRIES = Number(getArg('retries', '3'));
const TIMEOUT = Number(getArg('timeout', '30000'));
const RESUME = argv.includes('--resume');
const VALIDATE = argv.includes('--validate');
const REBUILD_SCHEMA = argv.includes('--rebuild-schema');

// PostgreSQL Schema - Normalized for better performance and validation
const SCHEMA = `
-- Main epochs table with core and bounds metadata
CREATE TABLE IF NOT EXISTS epochs (
  epoch INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL,
  start_block INTEGER NOT NULL,
  start_hash TEXT NOT NULL,
  end_block INTEGER NOT NULL,
  end_hash TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Domain staking summary (structured data)
CREATE TABLE IF NOT EXISTS epoch_staking_summary (
  epoch INTEGER PRIMARY KEY REFERENCES epochs(epoch) ON DELETE CASCADE,
  current_epoch_index INTEGER,
  total_stake TEXT, -- BigInt as string
  total_shares TEXT, -- BigInt as string
  total_operators INTEGER,
  total_registered_operators INTEGER,
  total_online_operators INTEGER,
  total_offline_operators INTEGER,
  total_slashed_operators INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Financial metrics
CREATE TABLE IF NOT EXISTS epoch_financial_metrics (
  epoch INTEGER PRIMARY KEY REFERENCES epochs(epoch) ON DELETE CASCADE,
  accumulated_treasury_funds TEXT, -- BigInt as string
  domain_chain_rewards TEXT, -- BigInt as string
  total_storage_fee_deposit TEXT, -- BigInt as string
  total_stake TEXT, -- BigInt as string (end-of-epoch)
  total_shares TEXT, -- BigInt as string (end-of-epoch)
  start_total_stake TEXT, -- BigInt as string (start-of-epoch)
  start_total_shares TEXT, -- BigInt as string (start-of-epoch)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Per-operator metrics per epoch
CREATE TABLE IF NOT EXISTS epoch_operator_metrics (
  epoch INTEGER REFERENCES epochs(epoch) ON DELETE CASCADE,
  operator_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK (snapshot IN ('start','end')),
  stake TEXT,
  shares TEXT,
  share_price TEXT,
  rewards TEXT,
  total_storage_fee_deposit TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (epoch, operator_id, snapshot)
);

-- Domain state metrics
CREATE TABLE IF NOT EXISTS epoch_domain_state (
  epoch INTEGER PRIMARY KEY REFERENCES epochs(epoch) ON DELETE CASCADE,
  head_domain_number INTEGER,
  head_receipt_number INTEGER,
  new_added_head_receipt INTEGER,
  consensus_block_hash TEXT,
  pending_staking_operation_count INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Collection counts (for quick analytics)
CREATE TABLE IF NOT EXISTS epoch_collection_counts (
  epoch INTEGER PRIMARY KEY REFERENCES epochs(epoch) ON DELETE CASCADE,
  deposits_count INTEGER DEFAULT 0,
  withdrawals_count INTEGER DEFAULT 0,
  deposit_on_hold_count INTEGER DEFAULT 0,
  successful_bundles_count INTEGER DEFAULT 0,
  operator_epoch_share_price_count INTEGER DEFAULT 0,
  operator_highest_slot_count INTEGER DEFAULT 0,
  operator_bundle_slot_count INTEGER DEFAULT 0,
  pending_slashes_count INTEGER DEFAULT 0,
  last_epoch_staking_distribution_count INTEGER DEFAULT 0,
  invalid_bundle_authors_count INTEGER DEFAULT 0,
  latest_confirmed_domain_execution_receipt_count INTEGER DEFAULT 0,
  domain_genesis_block_execution_receipt_count INTEGER DEFAULT 0,
  latest_submitted_er_count INTEGER DEFAULT 0,
  operators_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Detailed collections (JSON for complex data)
CREATE TABLE IF NOT EXISTS epoch_collections (
  epoch INTEGER PRIMARY KEY REFERENCES epochs(epoch) ON DELETE CASCADE,
  deposits JSONB,
  withdrawals JSONB,
  deposit_on_hold JSONB,
  successful_bundles JSONB,
  operator_epoch_share_price JSONB,
  operator_highest_slot JSONB,
  operator_bundle_slot JSONB,
  pending_slashes JSONB,
  last_epoch_staking_distribution JSONB,
  invalid_bundle_authors JSONB,
  latest_confirmed_domain_execution_receipt JSONB,
  domain_genesis_block_execution_receipt JSONB,
  latest_submitted_er JSONB,
  operators JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Raw domain registry data (JSON)
CREATE TABLE IF NOT EXISTS epoch_domain_registry (
  epoch INTEGER PRIMARY KEY REFERENCES epochs(epoch) ON DELETE CASCADE,
  domain_registry JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_epochs_domain_id ON epochs(domain_id);
CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs(timestamp);
CREATE INDEX IF NOT EXISTS idx_epochs_created_at ON epochs(created_at);
CREATE INDEX IF NOT EXISTS idx_epochs_updated_at ON epochs(updated_at);

CREATE INDEX IF NOT EXISTS idx_operator_metrics_operator ON epoch_operator_metrics(operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_metrics_stake ON epoch_operator_metrics((stake));

CREATE INDEX IF NOT EXISTS idx_staking_summary_current_epoch ON epoch_staking_summary(current_epoch_index);
CREATE INDEX IF NOT EXISTS idx_financial_total_stake ON epoch_financial_metrics(total_stake);
CREATE INDEX IF NOT EXISTS idx_financial_total_shares ON epoch_financial_metrics(total_shares);
CREATE INDEX IF NOT EXISTS idx_domain_state_head_domain ON epoch_domain_state(head_domain_number);
CREATE INDEX IF NOT EXISTS idx_domain_state_head_receipt ON epoch_domain_state(head_receipt_number);

-- GIN indexes for JSONB columns
CREATE INDEX IF NOT EXISTS idx_collections_deposits_gin ON epoch_collections USING GIN (deposits);
CREATE INDEX IF NOT EXISTS idx_collections_operators_gin ON epoch_collections USING GIN (operators);
CREATE INDEX IF NOT EXISTS idx_collections_successful_bundles_gin ON epoch_collections USING GIN (successful_bundles);

-- Statistics table
CREATE TABLE IF NOT EXISTS backfill_stats (
  id SERIAL PRIMARY KEY,
  domain_id INTEGER NOT NULL,
  total_epochs INTEGER DEFAULT 0,
  first_epoch INTEGER,
  last_epoch INTEGER,
  first_timestamp BIGINT,
  last_timestamp BIGINT,
  total_size_bytes BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Configuration table
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default config
INSERT INTO config (key, value, description) VALUES 
  ('schema_version', '2.0.0', 'Database schema version'),
  ('backfill_version', '2.0.0', 'Backfill script version')
ON CONFLICT (key) DO UPDATE SET 
  value = EXCLUDED.value,
  updated_at = CURRENT_TIMESTAMP;
`;

// Connection pool for managing multiple API connections
class ConnectionPool {
  constructor(url, user, pass, size = 5) {
    this.url = url;
    this.user = user;
    this.pass = pass;
    this.size = size;
    this.connections = [];
    this.available = [];
    this.inUse = new Set();
  }

  async initialize() {
    console.log(`[pool] Initializing ${this.size} connections...`);
    for (let i = 0; i < this.size; i++) {
      try {
        const api = await activate({ 
          rpcUrl: this.url, 
          rpcUser: this.user, 
          rpcPass: this.pass 
        });
        this.connections.push(api);
        this.available.push(api);
      } catch (e) {
        console.error(`[pool] Failed to initialize connection ${i}: ${e.message}`);
      }
    }
    console.log(`[pool] ${this.available.length}/${this.size} connections ready`);
  }

  async getConnection() {
    if (this.available.length === 0) {
      return new Promise(resolve => {
        const check = () => {
          if (this.available.length > 0) {
            resolve(this.getConnection());
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    }

    const api = this.available.pop();
    this.inUse.add(api);
    return api;
  }

  releaseConnection(api) {
    if (this.inUse.has(api)) {
      this.inUse.delete(api);
      this.available.push(api);
    }
  }

  async close() {
    console.log(`[pool] Closing ${this.connections.length} connections...`);
    await Promise.all(this.connections.map(api => api.disconnect()));
  }
}

// PostgreSQL Database manager
class PostgresManager {
  constructor(config) {
    this.pool = new Pool(config);
  }

  async initialize() {
    console.log(`[db] Initializing PostgreSQL connection...`);
    
    // Test connection
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT version()');
      console.log(`[db] Connected to PostgreSQL: ${result.rows[0].version.split(' ')[0]}`);
    } finally {
      client.release();
    }

    if (REBUILD_SCHEMA) {
      console.log(`[db] Rebuilding schema...`);
      await this.pool.query(`
        DROP TABLE IF EXISTS epoch_operator_metrics;
        DROP TABLE IF EXISTS epoch_collections;
        DROP TABLE IF EXISTS epoch_collection_counts;
        DROP TABLE IF EXISTS epoch_domain_registry;
        DROP TABLE IF EXISTS epoch_domain_state;
        DROP TABLE IF EXISTS epoch_financial_metrics;
        DROP TABLE IF EXISTS epoch_staking_summary;
        DROP TABLE IF EXISTS backfill_stats;
        DROP TABLE IF EXISTS config;
        DROP TABLE IF EXISTS epochs;
      `);
    }

    // Create schema
    await this.pool.query(SCHEMA);
    console.log(`[db] Schema initialized`);
  }

  async saveEpoch(epoch, startBlock, startHash, endBlock, endHash, metrics) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Insert main epoch record
      await client.query(
        'INSERT INTO epochs (epoch, domain_id, start_block, start_hash, end_block, end_hash, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (epoch) DO UPDATE SET start_block = $3, start_hash = $4, end_block = $5, end_hash = $6, timestamp = $7, updated_at = CURRENT_TIMESTAMP',
        [epoch, DOMAIN_ID, startBlock, startHash, endBlock, endHash, metrics.timestamp]
      );

      // Parse domain staking summary
      const stakingSummary = this.parseStakingSummary(metrics.domainStakingSummary);
      if (stakingSummary) {
        // Prefer computed totals and operator count from metrics to avoid human-formatted values
        const sumTotalStake = metrics.totalStake ?? stakingSummary.totalStake;
        const sumTotalShares = metrics.totalShares ?? stakingSummary.totalShares;
        const sumTotalOperators = metrics.operators?.count ?? stakingSummary.totalOperators;
        await client.query(
          `INSERT INTO epoch_staking_summary (
            epoch, current_epoch_index, total_stake, total_shares, total_operators,
            total_registered_operators, total_online_operators, total_offline_operators, total_slashed_operators
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (epoch) DO UPDATE SET
            current_epoch_index = $2, total_stake = $3, total_shares = $4, total_operators = $5,
            total_registered_operators = $6, total_online_operators = $7, total_offline_operators = $8, total_slashed_operators = $9`,
          [epoch, stakingSummary.currentEpochIndex, String(sumTotalStake), String(sumTotalShares),
           sumTotalOperators ?? stakingSummary.totalOperators, stakingSummary.totalRegisteredOperators, stakingSummary.totalOnlineOperators,
           stakingSummary.totalOfflineOperators, stakingSummary.totalSlashedOperators]
        );
      }

      // Insert financial metrics
      await client.query(
        `INSERT INTO epoch_financial_metrics (
          epoch, accumulated_treasury_funds, domain_chain_rewards, total_storage_fee_deposit, total_stake, total_shares, start_total_stake, start_total_shares
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (epoch) DO UPDATE SET
          accumulated_treasury_funds = $2, domain_chain_rewards = $3, total_storage_fee_deposit = $4, total_stake = $5, total_shares = $6, start_total_stake = $7, start_total_shares = $8`,
        [epoch, metrics.accumulatedTreasuryFunds, metrics.domainChainRewards, metrics.totalStorageFeeDeposit,
         metrics.totalStake, metrics.totalShares, metrics.startTotalStake, metrics.startTotalShares]
      );

      // Helper function to safely convert to integer
      const toInt = (value) => {
        if (value === null || value === undefined || value === '') return 0;
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? 0 : parsed;
      };

      // Insert domain state metrics
      await client.query(
        `INSERT INTO epoch_domain_state (
          epoch, head_domain_number, head_receipt_number, new_added_head_receipt, consensus_block_hash, pending_staking_operation_count
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (epoch) DO UPDATE SET
          head_domain_number = $2, head_receipt_number = $3, new_added_head_receipt = $4, consensus_block_hash = $5, pending_staking_operation_count = $6`,
        [epoch, toInt(metrics.headDomainNumber), toInt(metrics.headReceiptNumber), toInt(metrics.newAddedHeadReceipt),
         metrics.consensusBlockHash, toInt(metrics.pendingStakingOperationCount)]
      );

      // Insert collection counts
      await client.query(
        `INSERT INTO epoch_collection_counts (
          epoch, deposits_count, withdrawals_count, deposit_on_hold_count, successful_bundles_count,
          operator_epoch_share_price_count, operator_highest_slot_count, operator_bundle_slot_count,
          pending_slashes_count, last_epoch_staking_distribution_count, invalid_bundle_authors_count,
          latest_confirmed_domain_execution_receipt_count, domain_genesis_block_execution_receipt_count,
          latest_submitted_er_count, operators_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (epoch) DO UPDATE SET
          deposits_count = $2, withdrawals_count = $3, deposit_on_hold_count = $4, successful_bundles_count = $5,
          operator_epoch_share_price_count = $6, operator_highest_slot_count = $7, operator_bundle_slot_count = $8,
          pending_slashes_count = $9, last_epoch_staking_distribution_count = $10, invalid_bundle_authors_count = $11,
          latest_confirmed_domain_execution_receipt_count = $12, domain_genesis_block_execution_receipt_count = $13,
          latest_submitted_er_count = $14, operators_count = $15`,
        [epoch, metrics.deposits.count, metrics.withdrawals.count, metrics.depositOnHold.count, metrics.successfulBundles.count,
         metrics.operatorEpochSharePrice.count, metrics.operatorHighestSlot.count, metrics.operatorBundleSlot.count,
         metrics.pendingSlashes.count, metrics.lastEpochStakingDistribution.count, metrics.invalidBundleAuthors.count,
         metrics.latestConfirmedDomainExecutionReceipt.count, metrics.domainGenesisBlockExecutionReceipt.count,
         metrics.latestSubmittedER.count, metrics.operators.count]
      );

      // Insert detailed collections (JSONB)
      await client.query(
        `INSERT INTO epoch_collections (
          epoch, deposits, withdrawals, deposit_on_hold, successful_bundles, operator_epoch_share_price,
          operator_highest_slot, operator_bundle_slot, pending_slashes, last_epoch_staking_distribution,
          invalid_bundle_authors, latest_confirmed_domain_execution_receipt, domain_genesis_block_execution_receipt,
          latest_submitted_er, operators
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (epoch) DO UPDATE SET
          deposits = $2, withdrawals = $3, deposit_on_hold = $4, successful_bundles = $5, operator_epoch_share_price = $6,
          operator_highest_slot = $7, operator_bundle_slot = $8, pending_slashes = $9, last_epoch_staking_distribution = $10,
          invalid_bundle_authors = $11, latest_confirmed_domain_execution_receipt = $12, domain_genesis_block_execution_receipt = $13,
          latest_submitted_er = $14, operators = $15`,
        [epoch, JSON.stringify(metrics.deposits.entries), JSON.stringify(metrics.withdrawals.entries),
         JSON.stringify(metrics.depositOnHold.entries), JSON.stringify(metrics.successfulBundles.entries),
         JSON.stringify(metrics.operatorEpochSharePrice.entries), JSON.stringify(metrics.operatorHighestSlot.entries),
         JSON.stringify(metrics.operatorBundleSlot.entries), JSON.stringify(metrics.pendingSlashes.entries),
         JSON.stringify(metrics.lastEpochStakingDistribution.entries), JSON.stringify(metrics.invalidBundleAuthors.entries),
         JSON.stringify(metrics.latestConfirmedDomainExecutionReceipt.entries), JSON.stringify(metrics.domainGenesisBlockExecutionReceipt.entries),
         JSON.stringify(metrics.latestSubmittedER.entries), JSON.stringify(metrics.operators.entries)]
      );

      // Upsert per-operator metrics
      if (metrics.operatorMetrics && Array.isArray(metrics.operatorMetrics)) {
        for (const m of metrics.operatorMetrics) {
          await client.query(
            `INSERT INTO epoch_operator_metrics (
              epoch, operator_id, snapshot, stake, shares, share_price, rewards, total_storage_fee_deposit
            ) VALUES ($1, $2, 'end', $3, $4, $5, $6, $7)
            ON CONFLICT (epoch, operator_id, snapshot) DO UPDATE SET
              stake = $3, shares = $4, share_price = $5, rewards = $6, total_storage_fee_deposit = $7, updated_at = CURRENT_TIMESTAMP`,
            [epoch, m.operatorId, m.stake, m.shares, m.sharePrice, m.rewards, m.totalStorageFeeDeposit]
          );
        }
      }

      if (metrics.operatorStartMetrics && Array.isArray(metrics.operatorStartMetrics)) {
        for (const m of metrics.operatorStartMetrics) {
          await client.query(
            `INSERT INTO epoch_operator_metrics (
              epoch, operator_id, snapshot, stake, shares, share_price, rewards, total_storage_fee_deposit
            ) VALUES ($1, $2, 'start', $3, $4, $5, $6, $7)
            ON CONFLICT (epoch, operator_id, snapshot) DO UPDATE SET
              stake = $3, shares = $4, share_price = $5, rewards = $6, total_storage_fee_deposit = $7, updated_at = CURRENT_TIMESTAMP`,
            [epoch, m.operatorId, m.stake, m.shares, m.sharePrice, m.rewards, m.totalStorageFeeDeposit]
          );
        }
      }

      // Insert domain registry
      await client.query(
        'INSERT INTO epoch_domain_registry (epoch, domain_registry) VALUES ($1, $2) ON CONFLICT (epoch) DO UPDATE SET domain_registry = $2',
        [epoch, JSON.stringify(metrics.domainRegistry)]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  parseStakingSummary(summary) {
    if (!summary) return null;
    // Support multiple representations: codec object, toHuman() output, or nested JSON
    try {
      const s = summary.unwrap?.() ?? summary;
      const h = s.toHuman?.() ?? s;
      const j = typeof s.toJSON === 'function' ? s.toJSON() : (typeof h === 'object' ? h : s);
      const get = (k) => j?.[k] ?? s?.[k] ?? h?.[k];

      const toInt = (v) => {
        if (v === null || v === undefined || v === '') return 0;
        if (typeof v?.toNumber === 'function') return v.toNumber();
        const n = Number(v?.toString?.() ?? v);
        return Number.isFinite(n) ? n : 0;
      };
      const toStr = (v) => (v?.toString?.() ?? (typeof v === 'number' ? String(v) : (v ?? '0')));

      // Keys we’ve seen in JSON: currentEpochIndex, totalStake, totalShares, totalOperators, etc.
      const currentEpochIndex = get('currentEpochIndex') ?? get('epochIndex') ?? get('epoch');
      const totalStake = get('currentTotalStake') ?? get('totalStake');
      const totalShares = get('currentTotalShares') ?? get('totalShares');
      const totalOperators = get('totalOperators');
      const totalRegisteredOperators = get('totalRegisteredOperators');
      const totalOnlineOperators = get('totalOnlineOperators');
      const totalOfflineOperators = get('totalOfflineOperators');
      const totalSlashedOperators = get('totalSlashedOperators');

      return {
        current_epoch_index: toInt(currentEpochIndex),
        currentEpochIndex: toInt(currentEpochIndex),
        totalStake: toStr(totalStake) || '0',
        totalShares: toStr(totalShares) || '0',
        totalOperators: toInt(totalOperators),
        totalRegisteredOperators: toInt(totalRegisteredOperators),
        totalOnlineOperators: toInt(totalOnlineOperators),
        totalOfflineOperators: toInt(totalOfflineOperators),
        totalSlashedOperators: toInt(totalSlashedOperators)
      };
    } catch {
      return null;
    }
  }

  async getProcessedEpochs() {
    const result = await this.pool.query('SELECT epoch FROM epochs WHERE domain_id = $1 ORDER BY epoch', [DOMAIN_ID]);
    return result.rows.map(row => row.epoch);
  }

  async getLastProcessedEpoch() {
    const result = await this.pool.query('SELECT MAX(epoch) as max_epoch FROM epochs WHERE domain_id = $1', [DOMAIN_ID]);
    return result.rows[0]?.max_epoch ?? -1;
  }

  async validateEpoch(epoch) {
    const result = await this.pool.query(`
      SELECT 
        e.epoch,
        ess.current_epoch_index,
        efm.total_stake,
        efm.total_shares,
        eds.head_domain_number,
        eds.head_receipt_number,
        ecc.operators_count
      FROM epochs e
      LEFT JOIN epoch_staking_summary ess ON e.epoch = ess.epoch
      LEFT JOIN epoch_financial_metrics efm ON e.epoch = efm.epoch
      LEFT JOIN epoch_domain_state eds ON e.epoch = eds.epoch
      LEFT JOIN epoch_collection_counts ecc ON e.epoch = ecc.epoch
      WHERE e.epoch = $1 AND e.domain_id = $2
    `, [epoch, DOMAIN_ID]);
    
    return result.rows[0] || null;
  }

  async getStats() {
    const result = await this.pool.query(`
      SELECT 
        COUNT(*) as total_epochs,
        MIN(epoch) as first_epoch,
        MAX(epoch) as last_epoch,
        MIN(timestamp) as first_timestamp,
        MAX(timestamp) as last_timestamp
      FROM epochs 
      WHERE domain_id = $1
    `, [DOMAIN_ID]);
    
    return result.rows[0];
  }

  async close() {
    await this.pool.end();
  }
}

function mapToArray(m) {
  if (!m || !m.entries) return [];
  const out = [];
  try {
    for (const [k, v] of m.entries()) {
      const key = k.args ? k.args.map(a => a.toString()) : [k.toString()];
      out.push({ key, value: v?.toString?.() || JSON.stringify(v) });
    }
  } catch (e) {
    console.warn(`[mapToArray] error: ${e.message}`);
  }
  return out;
}

async function epochAt(api, blockNumber) {
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const at = await api.at(hash);
  const opt = await at.query.domains.domainStakingSummary(DOMAIN_ID);
  if (!opt || opt.isNone) return null;
  const s = opt.unwrap();
  const epoch = s.currentEpochIndex ?? s.epochIndex ?? s.epoch;
  return typeof epoch?.toNumber === 'function' ? epoch.toNumber() : Number(epoch);
}

async function findEpochStartBlock(api, targetEpoch) {
  const head = await api.rpc.chain.getHeader();
  let lo = 1, hi = head.number.toNumber();
  let ans = null;
  const cur = await epochAt(api, hi);
  if (cur == null) throw new Error('Cannot read epoch at head');
  if (targetEpoch > cur) throw new Error(`target epoch ${targetEpoch} > current ${cur}`);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const e = await epochAt(api, mid);
    if (e == null) { lo = mid + 1; continue; }
    if (e >= targetEpoch) { ans = mid; hi = mid; } else { lo = mid + 1; }
  }
  const eLo = await epochAt(api, lo);
  if (eLo !== targetEpoch) throw new Error(`Failed to locate start: epoch@${lo}=${eLo}`);
  return lo;
}

async function getComprehensiveMetrics(api, epoch, startBlock, endBlock) {
  const startHash = await api.rpc.chain.getBlockHash(startBlock);
  const endHash = await api.rpc.chain.getBlockHash(endBlock);
  const atStart = await api.at(startHash);
  const atEnd = await api.at(endHash);
  
  console.log(`[epoch.${epoch}] gathering comprehensive metrics at block ${endBlock}`);
  
  // Batch all queries together for better performance
  const queries = [
    // Basic domain info
    atEnd.query.domains.domainStakingSummary(DOMAIN_ID),
    atEnd.query.domains.domainRegistry(DOMAIN_ID),
    
    // Financial metrics
    atEnd.query.domains.accumulatedTreasuryFunds(),
    atEnd.query.domains.domainChainRewards(DOMAIN_ID),
    
    // Operational metrics
    atEnd.query.domains.pendingStakingOperationCount(DOMAIN_ID),
    
    // Domain state metrics
    atEnd.query.domains.headDomainNumber(DOMAIN_ID),
    atEnd.query.domains.headReceiptNumber(DOMAIN_ID),
    atEnd.query.domains.newAddedHeadReceipt(DOMAIN_ID),
    atEnd.query.domains.consensusBlockHash(DOMAIN_ID, 0),
    
    // Collections (these are more expensive)
    atEnd.query.domains.deposits.entries(),
    atEnd.query.domains.withdrawals.entries(),
    atEnd.query.domains.depositOnHold.entries(),
    atEnd.query.domains.successfulBundles.entries(),
    atEnd.query.domains.operatorEpochSharePrice.entries(),
    atEnd.query.domains.operatorHighestSlot.entries(),
    atEnd.query.domains.operatorBundleSlot.entries(),
    atEnd.query.domains.pendingSlashes.entries(),
    atEnd.query.domains.lastEpochStakingDistribution.entries(),
    atEnd.query.domains.invalidBundleAuthors.entries(),
    atEnd.query.domains.latestConfirmedDomainExecutionReceipt.entries(),
    atEnd.query.domains.domainGenesisBlockExecutionReceipt.entries(),
    atEnd.query.domains.latestSubmittedER.entries(),
    atEnd.query.domains.operators.entries()
  ];
  
  const results = await Promise.all(queries);
  
  const [
    domainStakingSummary, domainRegistry, accumulatedTreasuryFunds, domainChainRewards,
    pendingStakingOperationCount, headDomainNumber, headReceiptNumber, newAddedHeadReceipt,
    consensusBlockHashRaw, deposits, withdrawals, depositOnHold, successfulBundles,
    operatorEpochSharePrice, operatorHighestSlot, operatorBundleSlot, pendingSlashes,
    lastEpochStakingDistribution, invalidBundleAuthors, latestConfirmedDomainExecutionReceipt,
    domainGenesisBlockExecutionReceipt, latestSubmittedER, operators
  ] = results;
  
  // Extract operator rewards from domainStakingSummary (at end of epoch)
  let operatorRewardsMap = {};
  try {
    const dss = domainStakingSummary?.unwrap?.() ?? domainStakingSummary;
    const rewards = dss?.currentEpochRewards ?? dss?.toJSON?.()?.currentEpochRewards;
    if (rewards) {
      if (typeof rewards.entries === 'function') {
        for (const [k, v] of rewards.entries()) {
          const opId = k?.toNumber?.() ?? Number(k);
          operatorRewardsMap[opId] = v?.toString?.() ?? String(v);
        }
      } else {
        const j = rewards.toJSON?.() ?? rewards;
        if (j && typeof j === 'object') {
          for (const [k, v] of Object.entries(j)) {
            if (v && typeof v === 'object' && typeof v.toString === 'function') operatorRewardsMap[Number(k)] = v.toString();
            else if (typeof v === 'string' && v.startsWith('0x')) operatorRewardsMap[Number(k)] = BigInt(v).toString();
            else operatorRewardsMap[Number(k)] = String(v);
          }
        }
      }
    }
  } catch {}

  // Calculate storage fee deposits and per-operator metrics
  let totalStorageFeeDeposit = 0n;
  let totalStake = 0n;
  let totalShares = 0n;
  const operatorMetrics = [];

  // Also compute start-of-epoch aggregates
  let startTotalStake = 0n;
  let startTotalShares = 0n;
  const operatorStartMetrics = [];
  try {
    const startOperators = await atStart.query.domains.operators.entries();
    for (const [k, optVal] of startOperators) {
      const vv = optVal?.unwrap?.() ?? optVal;
      const sStake = vv?.currentTotalStake?.toString?.();
      const sShares = vv?.currentTotalShares?.toString?.();
      const sTfd = vv?.totalStorageFeeDeposit?.toString?.();
      if (sStake) startTotalStake += BigInt(sStake);
      if (sShares) startTotalShares += BigInt(sShares);
      const opId = k?.args?.[0]?.toNumber?.() ?? Number(k);
      let sPrice = null;
      if (sStake && sShares && sShares !== '0') {
        sPrice = ((BigInt(sStake) * 10n**18n) / BigInt(sShares)).toString();
      }
      operatorStartMetrics.push({
        operatorId: opId,
        stake: sStake ?? '0',
        shares: sShares ?? '0',
        sharePrice: sPrice,
        rewards: null,
        totalStorageFeeDeposit: sTfd ?? '0'
      });
    }
  } catch {}

  try {
    for (const [key, optVal] of operators) {
      const operatorId = key?.args?.[0]?.toNumber?.() ?? Number(key);
      const v = optVal?.unwrap?.() ?? optVal;
      const stake = v?.currentTotalStake?.toString?.() ?? null;
      const shares = v?.currentTotalShares?.toString?.() ?? null;
      const tfd = v?.totalStorageFeeDeposit?.toString?.() ?? null;
      if (stake) totalStake += BigInt(stake);
      if (shares) totalShares += BigInt(shares);
      if (tfd) totalStorageFeeDeposit += BigInt(tfd);

      // Try operator epoch share price
      let sharePrice = null;
      try {
        const sp = await atEnd.query.domains.operatorEpochSharePrice(DOMAIN_ID, [operatorId, epoch]);
        if (sp && sp.isSome !== undefined) sharePrice = sp.isSome ? sp.unwrap().toString() : null;
        else if (sp) sharePrice = sp.toString();
      } catch {}
      if (!sharePrice && stake && shares && shares !== '0') {
        sharePrice = ((BigInt(stake) * 10n**18n) / BigInt(shares)).toString();
      }

      operatorMetrics.push({
        operatorId,
        stake: stake ?? '0',
        shares: shares ?? '0',
        sharePrice: sharePrice ?? null,
        rewards: operatorRewardsMap[operatorId] ?? null,
        totalStorageFeeDeposit: tfd ?? '0'
      });
    }
  } catch {}
  
  // Resolve consensus block hash with a reliable fallback to the consensus header at endBlock
  let consensusBlockHashStr = undefined;
  try {
    consensusBlockHashStr = consensusBlockHashRaw?.toString();
  } catch {}
  try {
    if (!consensusBlockHashStr || /^0x0+$/.test(consensusBlockHashStr)) {
      const header = await api.rpc.chain.getHeader(endHash);
      consensusBlockHashStr = header.hash.toString();
    }
  } catch {}

  return {
    epoch,
    startBlock,
    endBlock,
    startHash: startHash.toString(),
    endHash: endHash.toString(),
    timestamp: Date.now(),
    
    // Basic domain info
    domainStakingSummary: domainStakingSummary?.unwrap?.()?.toHuman?.() || domainStakingSummary?.toString(),
    domainRegistry: domainRegistry?.unwrap?.()?.toHuman?.() || domainRegistry?.toString(),
    
    // Financial metrics
    accumulatedTreasuryFunds: accumulatedTreasuryFunds?.toString(),
    domainChainRewards: domainChainRewards?.toString(),
    totalStorageFeeDeposit: totalStorageFeeDeposit.toString(),
    totalStake: totalStake.toString(),
    totalShares: totalShares.toString(),
    startTotalStake: startTotalStake.toString(),
    startTotalShares: startTotalShares.toString(),
    
    // Deposits and withdrawals
    deposits: {
      count: deposits.length,
      entries: mapToArray(deposits)
    },
    withdrawals: {
      count: withdrawals.length,
      entries: mapToArray(withdrawals)
    },
    depositOnHold: {
      count: depositOnHold.length,
      entries: mapToArray(depositOnHold)
    },
    
    // Bundle and performance metrics
    successfulBundles: {
      count: successfulBundles.length,
      entries: mapToArray(successfulBundles)
    },
    operatorEpochSharePrice: {
      count: operatorEpochSharePrice.length,
      entries: mapToArray(operatorEpochSharePrice)
    },
    operatorHighestSlot: {
      count: operatorHighestSlot.length,
      entries: mapToArray(operatorHighestSlot)
    },
    operatorBundleSlot: {
      count: operatorBundleSlot.length,
      entries: mapToArray(operatorBundleSlot)
    },
    
    // Operational metrics
    pendingStakingOperationCount: pendingStakingOperationCount?.toString(),
    pendingSlashes: {
      count: pendingSlashes.length,
      entries: mapToArray(pendingSlashes)
    },
    lastEpochStakingDistribution: {
      count: lastEpochStakingDistribution.length,
      entries: mapToArray(lastEpochStakingDistribution)
    },
    invalidBundleAuthors: {
      count: invalidBundleAuthors.length,
      entries: mapToArray(invalidBundleAuthors)
    },
    
    // Domain state metrics
    headDomainNumber: headDomainNumber?.toString(),
    headReceiptNumber: headReceiptNumber?.toString(),
    newAddedHeadReceipt: newAddedHeadReceipt?.toString(),
    consensusBlockHash: consensusBlockHashStr,
    
    // Execution receipts
    latestConfirmedDomainExecutionReceipt: {
      count: latestConfirmedDomainExecutionReceipt.length,
      entries: mapToArray(latestConfirmedDomainExecutionReceipt)
    },
    domainGenesisBlockExecutionReceipt: {
      count: domainGenesisBlockExecutionReceipt.length,
      entries: mapToArray(domainGenesisBlockExecutionReceipt)
    },
    latestSubmittedER: {
      count: latestSubmittedER.length,
      entries: mapToArray(latestSubmittedER)
    },
    
    // Operators
    operators: {
      count: operators.length,
      entries: mapToArray(operators)
    },
    operatorMetrics,
    operatorStartMetrics
  };
}

// Worker function for processing epochs
async function processEpochBatch(pool, dbManager, epochs) {
  const api = await pool.getConnection();
  const results = [];
  
  try {
    for (const epoch of epochs) {
      try {
        const startBlock = await findEpochStartBlock(api, epoch);
        const nextStart = await findEpochStartBlock(api, epoch + 1);
        const endBlock = nextStart - 1;
        
        const metrics = await getComprehensiveMetrics(api, epoch, startBlock, endBlock);
        await dbManager.saveEpoch(epoch, startBlock, metrics.startHash, endBlock, metrics.endHash, metrics);
        
        results.push(metrics);
        console.log(`[epoch.${epoch}] ✅ completed`);
        
      } catch (e) {
        console.error(`[epoch.${epoch}.error] ${e.message}`);
        // Continue with next epoch
      }
    }
  } finally {
    pool.releaseConnection(api);
  }
  
  return results;
}

async function validateBackfill(dbManager, epochs) {
  console.log(`[validate] Validating ${epochs.length} epochs...`);
  
  let validCount = 0;
  let invalidCount = 0;
  
  for (const epoch of epochs) {
    const validation = await dbManager.validateEpoch(epoch);
    if (validation && validation.current_epoch_index === epoch) {
      validCount++;
    } else {
      invalidCount++;
      console.warn(`[validate] Epoch ${epoch} validation failed:`, validation);
    }
  }
  
  console.log(`[validate] Results: ${validCount} valid, ${invalidCount} invalid`);
  return { validCount, invalidCount };
}

async function main() {
  console.log(`[connect] ${WS}`);
  console.log(`[config] domain=${DOMAIN_ID}, concurrency=${CONCURRENCY}, batch-size=${BATCH_SIZE}`);
  console.log(`[db] PostgreSQL: ${DB_HOST}:${DB_PORT}/${DB_NAME}`);

  let pool, dbManager;
  
  try {
    // Initialize connection pool
    pool = new ConnectionPool(WS, RPC_USER, RPC_PASS, CONCURRENCY);
    await pool.initialize();

    // Initialize PostgreSQL database
    dbManager = new PostgresManager({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASS,
      max: CONCURRENCY + 5, // Connection pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    await dbManager.initialize();

    // Test connection and get node info
    const testApi = await pool.getConnection();
    try {
      const head = await testApi.rpc.chain.getHeader();
      console.log(`[connected] block #${head.number.toNumber()} • hash: ${head.hash.toString()}`);
      
      // Get chain name and version if available
      try {
        const [chain, version] = await Promise.all([
          testApi.rpc.system.chain(),
          testApi.rpc.system.version()
        ]);
        console.log(`[node] ${chain.toString()} v${version.toString()}`);
      } catch (e) {
        console.log(`[node] connected successfully`);
      }
    } finally {
      pool.releaseConnection(testApi);
    }

    const head = await testApi.rpc.chain.getHeader();
    const headEpoch = await epochAt(testApi, head.number.toNumber());
    console.log(`[head] epoch ${headEpoch}`);

    let fromEpoch = FROM ? Number(FROM) : 0;
    const toEpoch = TO === 'current' ? headEpoch : Number(TO);
    
    // Handle resume functionality
    if (RESUME) {
      const lastProcessed = await dbManager.getLastProcessedEpoch();
      if (lastProcessed >= 0) {
        fromEpoch = lastProcessed + 1;
        console.log(`[resume] continuing from epoch ${fromEpoch} (last processed: ${lastProcessed})`);
      }
    }
    
    console.log(`[range] epochs ${fromEpoch} to ${toEpoch}`);

    // Get already processed epochs
    const existingEpochs = new Set(await dbManager.getProcessedEpochs());

    // Prepare epochs to process
    const epochsToProcess = [];
    for (let epoch = fromEpoch; epoch <= toEpoch; epoch++) {
      if (!existingEpochs.has(epoch)) {
        epochsToProcess.push(epoch);
      } else {
        console.log(`[epoch.${epoch}] already exists, skipping`);
      }
    }

    if (epochsToProcess.length === 0) {
      console.log(`[complete] No epochs to process`);
      return;
    }

    console.log(`[process] ${epochsToProcess.length} epochs to process`);

    // Process epochs in batches
    const results = [];
    for (let i = 0; i < epochsToProcess.length; i += BATCH_SIZE) {
      const batch = epochsToProcess.slice(i, i + BATCH_SIZE);
      console.log(`[batch] processing epochs ${batch[0]} to ${batch[batch.length - 1]} (${batch.length} epochs)`);
      
      const batchResults = await processEpochBatch(pool, dbManager, batch);
      results.push(...batchResults);
    }

    console.log(`[complete] ${results.length} epochs processed`);

    // Validation if requested
    if (VALIDATE) {
      await validateBackfill(dbManager, epochsToProcess);
    }

    // Show final stats
    const stats = await dbManager.getStats();
    console.log(`[stats] Total epochs: ${stats.total_epochs}, Range: ${stats.first_epoch} - ${stats.last_epoch}`);

  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
    if (dbManager) await dbManager.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
