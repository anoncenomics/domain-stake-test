#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';

const { Pool } = pg;

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node migrate-sqlite-to-postgres.mjs [options]

Options:
  --sqlite <path>      SQLite database path (default: public/data/comprehensive-metrics.db)
  --pg-host <host>     PostgreSQL host (default: localhost)
  --pg-port <port>     PostgreSQL port (default: 5432)
  --pg-name <name>     PostgreSQL database name (default: domainstake)
  --pg-user <user>     PostgreSQL username (default: postgres)
  --pg-pass <pass>     PostgreSQL password
  --domain <id>        Domain ID to migrate (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'all' (default: all)
  --batch-size <n>     Number of epochs to migrate in each batch (default: 100)
  --dry-run            Show migration plan without executing
  --validate           Validate migrated data
  --help, -h           Show this help message

Environment Variables:
  SQLITE_PATH          SQLite database path (overrides --sqlite)
  PG_HOST              PostgreSQL host (overrides --pg-host)
  PG_PORT              PostgreSQL port (overrides --pg-port)
  PG_NAME              Database name (overrides --pg-name)
  PG_USER              Database username (overrides --pg-user)
  PG_PASS              Database password (overrides --pg-pass)
  DOMAIN               Domain ID (overrides --domain)

Examples:
  # Show migration plan
  node migrate-sqlite-to-postgres.mjs --dry-run

  # Migrate all epochs
  node migrate-sqlite-to-postgres.mjs --validate

  # Migrate specific range
  node migrate-sqlite-to-postgres.mjs --from 0 --to 1000 --batch-size 50

  # Use environment variables
  export PG_HOST=localhost
  export PG_NAME=domainstake
  export PG_USER=postgres
  export PG_PASS=password
  node migrate-sqlite-to-postgres.mjs --validate
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const SQLITE_PATH = getArg('sqlite', 'public/data/comprehensive-metrics.db');
const PG_HOST = getArg('pg-host', 'localhost');
const PG_PORT = Number(getArg('pg-port', '5432'));
const PG_NAME = getArg('pg-name', 'domainstake');
const PG_USER = getArg('pg-user', 'domainstake_user');
const PG_PASS = getArg('pg-pass', '');
const DOMAIN_ID = Number(getArg('domain', '0'));
const FROM = getArg('from');
const TO = getArg('to', 'all');
const BATCH_SIZE = Number(getArg('batch-size', '100'));
const DRY_RUN = argv.includes('--dry-run');
const VALIDATE = argv.includes('--validate');

// PostgreSQL Schema (same as in the main script)
const SCHEMA = `
-- Main epochs table with core metrics
CREATE TABLE IF NOT EXISTS epochs (
  epoch INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL,
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
  total_stake TEXT, -- BigInt as string
  total_shares TEXT, -- BigInt as string
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

CREATE INDEX IF NOT EXISTS idx_staking_summary_current_epoch ON epoch_staking_summary(current_epoch_index);
CREATE INDEX IF NOT EXISTS idx_financial_total_stake ON epoch_financial_metrics(total_stake);
CREATE INDEX IF NOT EXISTS idx_financial_total_shares ON epoch_financial_metrics(total_shares);
CREATE INDEX IF NOT EXISTS idx_domain_state_head_domain ON epoch_domain_state(head_domain_number);
CREATE INDEX IF NOT EXISTS idx_domain_state_head_receipt ON epoch_domain_state(head_receipt_number);

-- GIN indexes for JSONB columns
CREATE INDEX IF NOT EXISTS idx_collections_deposits_gin ON epoch_collections USING GIN (deposits);
CREATE INDEX IF NOT EXISTS idx_collections_operators_gin ON epoch_collections USING GIN (operators);
CREATE INDEX IF NOT EXISTS idx_collections_successful_bundles_gin ON epoch_collections USING GIN (successful_bundles);

-- Migration tracking table
CREATE TABLE IF NOT EXISTS migration_log (
  id SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_connection TEXT NOT NULL,
  domain_id INTEGER NOT NULL,
  total_epochs INTEGER DEFAULT 0,
  migrated_epochs INTEGER DEFAULT 0,
  failed_epochs INTEGER DEFAULT 0,
  start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_time TIMESTAMP,
  status TEXT DEFAULT 'running',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

class SqliteReader {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`SQLite database not found: ${this.dbPath}`);
    }

    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    console.log(`[sqlite] Connected to ${this.dbPath}`);
  }

  async getEpochs(fromEpoch = 0, toEpoch = null) {
    let query = 'SELECT epoch, end_block, end_hash, timestamp, data FROM epochs WHERE epoch >= ?';
    let params = [fromEpoch];

    if (toEpoch !== null) {
      query += ' AND epoch <= ?';
      params.push(toEpoch);
    }

    query += ' ORDER BY epoch';

    const rows = await this.db.all(query, params);
    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  }

  async getEpochCount() {
    const result = await this.db.get('SELECT COUNT(*) as count FROM epochs');
    return result.count;
  }

  async getEpochRange() {
    const result = await this.db.get('SELECT MIN(epoch) as min_epoch, MAX(epoch) as max_epoch FROM epochs');
    return { minEpoch: result.min_epoch, maxEpoch: result.max_epoch };
  }

  async close() {
    if (this.db) {
      await this.db.close();
    }
  }
}

class PostgresWriter {
  constructor(config) {
    this.config = config;
    this.pool = new Pool(config);
  }

  async initialize() {
    console.log(`[postgres] Connecting to ${this.config.host}:${this.config.port}/${this.config.database}`);
    
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT version()');
      console.log(`[postgres] Connected: ${result.rows[0].version.split(' ')[0]}`);
    } finally {
      client.release();
    }

    await this.pool.query(SCHEMA);
    console.log(`[postgres] Schema initialized`);
  }

  async saveEpoch(epoch, endBlock, endHash, timestamp, data) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Insert main epoch record
      await client.query(
        'INSERT INTO epochs (epoch, domain_id, end_block, end_hash, timestamp) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (epoch) DO UPDATE SET end_block = $3, end_hash = $4, timestamp = $5, updated_at = CURRENT_TIMESTAMP',
        [epoch, DOMAIN_ID, endBlock, endHash, timestamp]
      );

      // Parse domain staking summary
      const stakingSummary = this.parseStakingSummary(data.domainStakingSummary);
      if (stakingSummary) {
        await client.query(
          `INSERT INTO epoch_staking_summary (
            epoch, current_epoch_index, total_stake, total_shares, total_operators,
            total_registered_operators, total_online_operators, total_offline_operators, total_slashed_operators
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (epoch) DO UPDATE SET
            current_epoch_index = $2, total_stake = $3, total_shares = $4, total_operators = $5,
            total_registered_operators = $6, total_online_operators = $7, total_offline_operators = $8, total_slashed_operators = $9`,
          [epoch, stakingSummary.currentEpochIndex, stakingSummary.totalStake, stakingSummary.totalShares,
           stakingSummary.totalOperators, stakingSummary.totalRegisteredOperators, stakingSummary.totalOnlineOperators,
           stakingSummary.totalOfflineOperators, stakingSummary.totalSlashedOperators]
        );
      }

      // Insert financial metrics
      await client.query(
        `INSERT INTO epoch_financial_metrics (
          epoch, accumulated_treasury_funds, domain_chain_rewards, total_storage_fee_deposit, total_stake, total_shares
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (epoch) DO UPDATE SET
          accumulated_treasury_funds = $2, domain_chain_rewards = $3, total_storage_fee_deposit = $4, total_stake = $5, total_shares = $6`,
        [epoch, data.accumulatedTreasuryFunds, data.domainChainRewards, data.totalStorageFeeDeposit,
         data.totalStake, data.totalShares]
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
        [epoch, toInt(data.headDomainNumber), toInt(data.headReceiptNumber), toInt(data.newAddedHeadReceipt),
         data.consensusBlockHash, toInt(data.pendingStakingOperationCount)]
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
        [epoch, data.deposits?.count || 0, data.withdrawals?.count || 0, data.depositOnHold?.count || 0, data.successfulBundles?.count || 0,
         data.operatorEpochSharePrice?.count || 0, data.operatorHighestSlot?.count || 0, data.operatorBundleSlot?.count || 0,
         data.pendingSlashes?.count || 0, data.lastEpochStakingDistribution?.count || 0, data.invalidBundleAuthors?.count || 0,
         data.latestConfirmedDomainExecutionReceipt?.count || 0, data.domainGenesisBlockExecutionReceipt?.count || 0,
         data.latestSubmittedER?.count || 0, data.operators?.count || 0]
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
        [epoch, JSON.stringify(data.deposits?.entries || []), JSON.stringify(data.withdrawals?.entries || []),
         JSON.stringify(data.depositOnHold?.entries || []), JSON.stringify(data.successfulBundles?.entries || []),
         JSON.stringify(data.operatorEpochSharePrice?.entries || []), JSON.stringify(data.operatorHighestSlot?.entries || []),
         JSON.stringify(data.operatorBundleSlot?.entries || []), JSON.stringify(data.pendingSlashes?.entries || []),
         JSON.stringify(data.lastEpochStakingDistribution?.entries || []), JSON.stringify(data.invalidBundleAuthors?.entries || []),
         JSON.stringify(data.latestConfirmedDomainExecutionReceipt?.entries || []), JSON.stringify(data.domainGenesisBlockExecutionReceipt?.entries || []),
         JSON.stringify(data.latestSubmittedER?.entries || []), JSON.stringify(data.operators?.entries || [])]
      );

      // Insert domain registry
      await client.query(
        'INSERT INTO epoch_domain_registry (epoch, domain_registry) VALUES ($1, $2) ON CONFLICT (epoch) DO UPDATE SET domain_registry = $2',
        [epoch, JSON.stringify(data.domainRegistry)]
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
    if (!summary || typeof summary !== 'object') return null;
    
    // Helper function to safely convert to integer
    const toInt = (value) => {
      if (value === null || value === undefined || value === '') return 0;
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? 0 : parsed;
    };
    
    return {
      currentEpochIndex: toInt(summary.currentEpochIndex || summary.epochIndex || summary.epoch),
      totalStake: summary.totalStake?.toString() || '0',
      totalShares: summary.totalShares?.toString() || '0',
      totalOperators: toInt(summary.totalOperators),
      totalRegisteredOperators: toInt(summary.totalRegisteredOperators),
      totalOnlineOperators: toInt(summary.totalOnlineOperators),
      totalOfflineOperators: toInt(summary.totalOfflineOperators),
      totalSlashedOperators: toInt(summary.totalSlashedOperators)
    };
  }

  async createMigrationLog(sourcePath, totalEpochs) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        INSERT INTO migration_log (
          source_type, source_path, target_type, target_connection, domain_id, total_epochs
        ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, ['sqlite', sourcePath, 'postgres', `${PG_HOST}:${PG_PORT}/${PG_NAME}`, DOMAIN_ID, totalEpochs]);
      
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async updateMigrationLog(logId, migratedCount, failedCount, status = 'running', errorMessage = null) {
    const client = await this.pool.connect();
    try {
      await client.query(`
        UPDATE migration_log SET 
          migrated_epochs = $2, 
          failed_epochs = $3, 
          status = $4, 
          error_message = $5,
          end_time = CASE WHEN $4 IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE end_time END
        WHERE id = $1
      `, [logId, migratedCount, failedCount, status, errorMessage]);
    } finally {
      client.release();
    }
  }

  async validateEpoch(epoch) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
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
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

async function main() {
  console.log(`[migrate] SQLite to PostgreSQL Migration`);
  console.log(`[source] ${SQLITE_PATH}`);
  console.log(`[target] ${PG_HOST}:${PG_PORT}/${PG_NAME}`);
  console.log(`[domain] ${DOMAIN_ID}`);

  let sqliteReader, postgresWriter;
  
  try {
    // Initialize SQLite reader
    sqliteReader = new SqliteReader(SQLITE_PATH);
    await sqliteReader.initialize();

    // Initialize PostgreSQL writer
    postgresWriter = new PostgresWriter({
      host: PG_HOST,
      port: PG_PORT,
      database: PG_NAME,
      user: PG_USER,
      password: PG_PASS,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    await postgresWriter.initialize();

    // Get epoch information
    const epochCount = await sqliteReader.getEpochCount();
    const { minEpoch, maxEpoch } = await sqliteReader.getEpochRange();
    
    console.log(`[info] Found ${epochCount} epochs (${minEpoch} - ${maxEpoch})`);

    // Determine migration range
    const fromEpoch = FROM ? Number(FROM) : minEpoch;
    const toEpoch = TO === 'all' ? maxEpoch : Number(TO);
    
    console.log(`[range] Migrating epochs ${fromEpoch} to ${toEpoch}`);

    if (DRY_RUN) {
      console.log(`[dry-run] Would migrate ${toEpoch - fromEpoch + 1} epochs`);
      console.log(`[dry-run] Migration plan complete`);
      return;
    }

    // Create migration log
    const logId = await postgresWriter.createMigrationLog(SQLITE_PATH, epochCount);
    console.log(`[log] Migration log created with ID: ${logId}`);

    // Get epochs to migrate
    const epochs = await sqliteReader.getEpochs(fromEpoch, toEpoch);
    console.log(`[migrate] Starting migration of ${epochs.length} epochs`);

    let migratedCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // Migrate in batches
    for (let i = 0; i < epochs.length; i += BATCH_SIZE) {
      const batch = epochs.slice(i, i + BATCH_SIZE);
      console.log(`[batch] Processing epochs ${batch[0].epoch} to ${batch[batch.length - 1].epoch} (${batch.length} epochs)`);

      for (const epochData of batch) {
        try {
          await postgresWriter.saveEpoch(
            epochData.epoch,
            epochData.end_block,
            epochData.end_hash,
            epochData.timestamp,
            epochData.data
          );
          migratedCount++;
          
          if (migratedCount % 100 === 0) {
            console.log(`[progress] ${migratedCount}/${epochs.length} epochs migrated`);
            await postgresWriter.updateMigrationLog(logId, migratedCount, failedCount);
          }
        } catch (error) {
          failedCount++;
          console.error(`[error] Failed to migrate epoch ${epochData.epoch}: ${error.message}`);
        }
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    // Update final migration log
    const status = failedCount === 0 ? 'completed' : 'completed_with_errors';
    await postgresWriter.updateMigrationLog(logId, migratedCount, failedCount, status);

    console.log(`[complete] Migration finished in ${duration.toFixed(2)}s`);
    console.log(`[stats] Migrated: ${migratedCount}, Failed: ${failedCount}`);

    // Validation if requested
    if (VALIDATE) {
      console.log(`[validate] Validating migrated data...`);
      
      let validCount = 0;
      let invalidCount = 0;
      
      for (const epochData of epochs) {
        const validation = await postgresWriter.validateEpoch(epochData.epoch);
        if (validation && validation.current_epoch_index === epochData.epoch) {
          validCount++;
        } else {
          invalidCount++;
          console.warn(`[validate] Epoch ${epochData.epoch} validation failed:`, validation);
        }
      }
      
      console.log(`[validate] Results: ${validCount} valid, ${invalidCount} invalid`);
    }

  } catch (e) {
    console.error(`[error] Migration failed: ${e.message}`);
    process.exit(1);
  } finally {
    if (sqliteReader) await sqliteReader.close();
    if (postgresWriter) await postgresWriter.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
