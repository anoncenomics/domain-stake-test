import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { promisify } from 'util';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node optimized-comprehensive-backfill.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com/ws)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'current' (default: current)
  --db <path>          SQLite database path (default: public/data/comprehensive-metrics.db)
  --concurrency <n>    Number of concurrent workers (default: 5)
  --batch-size <n>     Number of epochs to process in each batch (default: 10)
  --retries <n>        Number of retries for failed requests (default: 3)
  --timeout <ms>       Request timeout in milliseconds (default: 30000)
  --resume             Resume from last processed epoch
  --help, -h           Show this help message

Environment Variables:
  RPC_URL_WS           WebSocket RPC endpoint (overrides --ws)
  RPC_USER             RPC username (overrides --user)
  RPC_PASS             RPC password (overrides --pass)
  DOMAIN               Domain ID (overrides --domain)
  FROM                 Starting epoch (overrides --from)
  TO                   Ending epoch (overrides --to)
  DB_PATH              Database path (overrides --db)
  CONCURRENCY          Number of workers (overrides --concurrency)
  BATCH_SIZE           Batch size (overrides --batch-size)

Examples:
  # Basic usage with defaults
  node optimized-comprehensive-backfill.mjs --domain 0

  # High-performance setup
  node optimized-comprehensive-backfill.mjs --domain 0 --concurrency 10 --batch-size 20

  # Resume interrupted backfill
  node optimized-comprehensive-backfill.mjs --domain 0 --resume

  # Use environment variables
  export RPC_USER=your_username
  export RPC_PASS=your_password
  export CONCURRENCY=8
  node optimized-comprehensive-backfill.mjs --domain 0
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
const DB_PATH = getArg('db', 'public/data/comprehensive-metrics.db');
const CONCURRENCY = Number(getArg('concurrency', '5'));
const BATCH_SIZE = Number(getArg('batch-size', '10'));
const RETRIES = Number(getArg('retries', '3'));
const TIMEOUT = Number(getArg('timeout', '30000'));
const RESUME = argv.includes('--resume');

// Database schema
const SCHEMA = `
CREATE TABLE IF NOT EXISTS epochs (
  epoch INTEGER PRIMARY KEY,
  end_block INTEGER NOT NULL,
  end_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epochs_epoch ON epochs(epoch);
CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs(timestamp);
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
      // Wait for a connection to become available
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

// Database manager
class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    await this.db.exec(SCHEMA);
    console.log(`[db] Database initialized at ${this.dbPath}`);
  }

  async saveEpoch(epoch, endBlock, endHash, data) {
    const stmt = await this.db.prepare(
      'INSERT OR REPLACE INTO epochs (epoch, end_block, end_hash, timestamp, data) VALUES (?, ?, ?, ?, ?)'
    );
    await stmt.run(epoch, endBlock, endHash, Date.now(), JSON.stringify(data));
    await stmt.finalize();
  }

  async getEpoch(epoch) {
    const row = await this.db.get('SELECT * FROM epochs WHERE epoch = ?', epoch);
    return row ? JSON.parse(row.data) : null;
  }

  async getProcessedEpochs() {
    const rows = await this.db.all('SELECT epoch FROM epochs ORDER BY epoch');
    return rows.map(row => row.epoch);
  }

  async getLastProcessedEpoch() {
    const row = await this.db.get('SELECT MAX(epoch) as max_epoch FROM epochs');
    return row?.max_epoch ?? -1;
  }

  async getStats() {
    const row = await this.db.get('SELECT COUNT(*) as count FROM epochs');
    return row?.count ?? 0;
  }

  async close() {
    if (this.db) {
      await this.db.close();
    }
  }
}

// Utility functions
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

async function getComprehensiveMetrics(api, epoch, endBlock) {
  const endHash = await api.rpc.chain.getBlockHash(endBlock);
  const atEnd = await api.at(endHash);
  
  // Use Promise.all to fetch all queries concurrently
  const [
    domainStakingSummary,
    domainRegistry,
    accumulatedTreasuryFunds,
    domainChainRewards,
    deposits,
    withdrawals,
    depositOnHold,
    successfulBundles,
    operatorEpochSharePrice,
    operatorHighestSlot,
    operatorBundleSlot,
    pendingStakingOperationCount,
    pendingSlashes,
    lastEpochStakingDistribution,
    invalidBundleAuthors,
    headDomainNumber,
    headReceiptNumber,
    newAddedHeadReceipt,
    consensusBlockHash,
    latestConfirmedDomainExecutionReceipt,
    domainGenesisBlockExecutionReceipt,
    latestSubmittedER,
    operators
  ] = await Promise.all([
    atEnd.query.domains.domainStakingSummary(DOMAIN_ID),
    atEnd.query.domains.domainRegistry(DOMAIN_ID),
    atEnd.query.domains.accumulatedTreasuryFunds(),
    atEnd.query.domains.domainChainRewards(DOMAIN_ID),
    atEnd.query.domains.deposits.entries(),
    atEnd.query.domains.withdrawals.entries(),
    atEnd.query.domains.depositOnHold.entries(),
    atEnd.query.domains.successfulBundles.entries(),
    atEnd.query.domains.operatorEpochSharePrice.entries(),
    atEnd.query.domains.operatorHighestSlot.entries(),
    atEnd.query.domains.operatorBundleSlot.entries(),
    atEnd.query.domains.pendingStakingOperationCount(DOMAIN_ID),
    atEnd.query.domains.pendingSlashes.entries(),
    atEnd.query.domains.lastEpochStakingDistribution.entries(),
    atEnd.query.domains.invalidBundleAuthors.entries(),
    atEnd.query.domains.headDomainNumber(DOMAIN_ID),
    atEnd.query.domains.headReceiptNumber(DOMAIN_ID),
    atEnd.query.domains.newAddedHeadReceipt(DOMAIN_ID),
    atEnd.query.domains.consensusBlockHash(DOMAIN_ID, 0),
    atEnd.query.domains.latestConfirmedDomainExecutionReceipt.entries(),
    atEnd.query.domains.domainGenesisBlockExecutionReceipt.entries(),
    atEnd.query.domains.latestSubmittedER.entries(),
    atEnd.query.domains.operators.entries()
  ]);
  
  // Calculate totals from operators
  let totalStorageFeeDeposit = 0;
  let totalStake = 0;
  let totalShares = 0;
  
  for (const [key, operator] of operators) {
    if (operator) {
      if (operator.totalStorageFeeDeposit) {
        totalStorageFeeDeposit += BigInt(operator.totalStorageFeeDeposit.toString());
      }
      if (operator.currentTotalStake) {
        totalStake += BigInt(operator.currentTotalStake.toString());
      }
      if (operator.currentTotalShares) {
        totalShares += BigInt(operator.currentTotalShares.toString());
      }
    }
  }
  
  return {
    epoch,
    endBlock,
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
    
    // Deposits and withdrawals
    deposits: { count: deposits.length, entries: mapToArray(deposits) },
    withdrawals: { count: withdrawals.length, entries: mapToArray(withdrawals) },
    depositOnHold: { count: depositOnHold.length, entries: mapToArray(depositOnHold) },
    
    // Bundle and performance metrics
    successfulBundles: { count: successfulBundles.length, entries: mapToArray(successfulBundles) },
    operatorEpochSharePrice: { count: operatorEpochSharePrice.length, entries: mapToArray(operatorEpochSharePrice) },
    operatorHighestSlot: { count: operatorHighestSlot.length, entries: mapToArray(operatorHighestSlot) },
    operatorBundleSlot: { count: operatorBundleSlot.length, entries: mapToArray(operatorBundleSlot) },
    
    // Operational metrics
    pendingStakingOperationCount: pendingStakingOperationCount?.toString(),
    pendingSlashes: { count: pendingSlashes.length, entries: mapToArray(pendingSlashes) },
    lastEpochStakingDistribution: { count: lastEpochStakingDistribution.length, entries: mapToArray(lastEpochStakingDistribution) },
    invalidBundleAuthors: { count: invalidBundleAuthors.length, entries: mapToArray(invalidBundleAuthors) },
    
    // Domain state metrics
    headDomainNumber: headDomainNumber?.toString(),
    headReceiptNumber: headReceiptNumber?.toString(),
    newAddedHeadReceipt: newAddedHeadReceipt?.toString(),
    consensusBlockHash: consensusBlockHash?.toString(),
    
    // Execution receipts
    latestConfirmedDomainExecutionReceipt: { count: latestConfirmedDomainExecutionReceipt.length, entries: mapToArray(latestConfirmedDomainExecutionReceipt) },
    domainGenesisBlockExecutionReceipt: { count: domainGenesisBlockExecutionReceipt.length, entries: mapToArray(domainGenesisBlockExecutionReceipt) },
    latestSubmittedER: { count: latestSubmittedER.length, entries: mapToArray(latestSubmittedER) },
    
    // Operators
    operators: { count: operators.length, entries: mapToArray(operators) }
  };
}

// Worker function for processing epochs
async function processEpoch(api, epoch, db) {
  try {
    const startBlock = await findEpochStartBlock(api, epoch);
    const nextStart = await findEpochStartBlock(api, epoch + 1);
    const endBlock = nextStart - 1;
    
    const metrics = await getComprehensiveMetrics(api, epoch, endBlock);
    await db.saveEpoch(epoch, endBlock, metrics.endHash, metrics);
    
    return { epoch, success: true };
  } catch (e) {
    return { epoch, success: false, error: e.message };
  }
}

// Main processing function with concurrency
async function processEpochsConcurrently(epochs, pool, db) {
  const results = [];
  const batches = [];
  
  // Split epochs into batches
  for (let i = 0; i < epochs.length; i += BATCH_SIZE) {
    batches.push(epochs.slice(i, i + BATCH_SIZE));
  }
  
  console.log(`[process] Processing ${epochs.length} epochs in ${batches.length} batches with ${CONCURRENCY} workers`);
  
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`[batch.${batchIndex + 1}/${batches.length}] Processing epochs ${batch[0]} to ${batch[batch.length - 1]}`);
    
    const batchPromises = batch.map(async (epoch) => {
      const api = await pool.getConnection();
      try {
        const result = await processEpoch(api, epoch, db);
        if (result.success) {
          console.log(`[epoch.${epoch}] ✅ completed`);
        } else {
          console.error(`[epoch.${epoch}] ❌ failed: ${result.error}`);
        }
        return result;
      } finally {
        pool.releaseConnection(api);
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Progress update
    const completed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`[progress] ${completed} completed, ${failed} failed, ${epochs.length - completed - failed} remaining`);
  }
  
  return results;
}

async function main() {
  console.log(`[config] domain=${DOMAIN_ID}, concurrency=${CONCURRENCY}, batch-size=${BATCH_SIZE}`);
  console.log(`[db] ${DB_PATH}`);
  
  // Initialize database
  const db = new DatabaseManager(DB_PATH);
  await db.initialize();
  
  // Initialize connection pool
  const pool = new ConnectionPool(WS, RPC_USER, RPC_PASS, CONCURRENCY);
  await pool.initialize();
  
  try {
    // Test connection
    const testApi = await pool.getConnection();
    try {
      const head = await testApi.rpc.chain.getHeader();
      console.log(`[connected] block #${head.number.toNumber()} • hash: ${head.hash.toString()}`);
      
      const [chain, version] = await Promise.all([
        testApi.rpc.system.chain(),
        testApi.rpc.system.version()
      ]);
      console.log(`[node] ${chain.toString()} v${version.toString()}`);
      
      const headEpoch = await epochAt(testApi, head.number.toNumber());
      console.log(`[head] epoch ${headEpoch}`);
      
      const fromEpoch = FROM ? Number(FROM) : 0;
      const toEpoch = TO === 'current' ? headEpoch : Number(TO);
      
      console.log(`[range] epochs ${fromEpoch} to ${toEpoch}`);
      
      // Handle resume functionality
      let startEpoch = fromEpoch;
      if (RESUME) {
        const lastProcessed = await db.getLastProcessedEpoch();
        if (lastProcessed >= 0) {
          startEpoch = lastProcessed + 1;
          console.log(`[resume] Starting from epoch ${startEpoch} (last processed: ${lastProcessed})`);
        }
      }
      
      // Get already processed epochs
      const processedEpochs = new Set(await db.getProcessedEpochs());
      
      // Generate list of epochs to process
      const epochsToProcess = [];
      for (let epoch = startEpoch; epoch <= toEpoch; epoch++) {
        if (!processedEpochs.has(epoch)) {
          epochsToProcess.push(epoch);
        }
      }
      
      if (epochsToProcess.length === 0) {
        console.log(`[complete] All epochs already processed`);
        return;
      }
      
      console.log(`[process] ${epochsToProcess.length} epochs to process`);
      
      // Process epochs with concurrency
      const results = await processEpochsConcurrently(epochsToProcess, pool, db);
      
      // Summary
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      const totalProcessed = await db.getStats();
      
      console.log(`[complete] Processing finished`);
      console.log(`[summary] ${successful} successful, ${failed} failed`);
      console.log(`[summary] Total epochs in database: ${totalProcessed}`);
      
    } finally {
      pool.releaseConnection(testApi);
    }
    
  } finally {
    await pool.close();
    await db.close();
  }
}

main().catch(e => { 
  console.error(`[fatal] ${e.message}`);
  console.error(e.stack);
  process.exit(1); 
});
