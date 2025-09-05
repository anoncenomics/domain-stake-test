import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node backfill-optimized.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com/ws)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'current' (default: current)
  --db <path>          SQLite database path (default: public/data/comprehensive-metrics-optimized.db)
  --concurrency <n>    Number of concurrent workers (default: 8)
  --batch-size <n>     Number of epochs to process in each batch (default: 50)
  --lightweight        Use lightweight mode (skip large collections)
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
  # High-performance backfill
  node backfill-optimized.mjs --domain 0 --concurrency 12 --batch-size 100

  # Lightweight mode (faster)
  node backfill-optimized.mjs --domain 0 --lightweight --concurrency 15

  # Resume interrupted backfill
  node backfill-optimized.mjs --domain 0 --resume
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
const DB_PATH = getArg('db', 'public/data/comprehensive-metrics-optimized.db');
const CONCURRENCY = Number(getArg('concurrency', '8'));
const BATCH_SIZE = Number(getArg('batch-size', '50'));
const RESUME = argv.includes('--resume');
const LIGHTWEIGHT = argv.includes('--lightweight');

// Optimized database schema
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

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

// Optimized connection pool with better error handling
class OptimizedConnectionPool {
  constructor(url, user, pass, size = 8) {
    this.url = url;
    this.user = user;
    this.pass = pass;
    this.size = size;
    this.connections = [];
    this.available = [];
    this.inUse = new Set();
    this.failed = 0;
    this.maxRetries = 3;
  }

  async initialize() {
    console.log(`[pool] Initializing ${this.size} connections...`);
    const promises = [];
    
    for (let i = 0; i < this.size; i++) {
      promises.push(this.createConnection(i));
    }
    
    await Promise.allSettled(promises);
    console.log(`[pool] ${this.available.length}/${this.size} connections ready`);
  }

  async createConnection(index) {
    try {
      const api = await activate({ 
        rpcUrl: this.url, 
        rpcUser: this.user, 
        rpcPass: this.pass 
      });
      this.connections.push(api);
      this.available.push(api);
    } catch (e) {
      console.error(`[pool] Failed to initialize connection ${index}: ${e.message}`);
    }
  }

  async getConnection() {
    if (this.available.length === 0) {
      return new Promise(resolve => {
        const check = () => {
          if (this.available.length > 0) {
            resolve(this.getConnection());
          } else {
            setTimeout(check, 50); // Faster polling
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
    await Promise.allSettled(this.connections.map(api => api.disconnect()));
  }
}

// Optimized database manager
class OptimizedDatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    ensureDir(this.dbPath);
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

  async getLastProcessedEpoch() {
    const row = await this.db.get('SELECT MAX(epoch) as max_epoch FROM epochs');
    return row?.max_epoch ?? -1;
  }

  async getProcessedEpochs() {
    const rows = await this.db.all('SELECT epoch FROM epochs ORDER BY epoch');
    return rows.map(row => row.epoch);
  }

  async close() {
    if (this.db) {
      await this.db.close();
    }
  }
}

async function findEpochAt(api, blockNumber) {
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
  const cur = await findEpochAt(api, hi);
  if (cur == null) throw new Error('Cannot read epoch at head');
  if (targetEpoch > cur) throw new Error(`target epoch ${targetEpoch} > current ${cur}`);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const e = await findEpochAt(api, mid);
    if (e == null) { lo = mid + 1; continue; }
    if (e >= targetEpoch) { ans = mid; hi = mid; } else { lo = mid + 1; }
  }
  const eLo = await findEpochAt(api, lo);
  if (eLo !== targetEpoch) throw new Error(`Failed to locate start: epoch@${lo}=${eLo}`);
  return lo;
}

// Optimized metrics collection - lightweight mode
async function getOptimizedMetrics(api, epoch, endBlock) {
  const endHash = await api.rpc.chain.getBlockHash(endBlock);
  const atEnd = await api.at(endHash);
  
  console.log(`[epoch.${epoch}] gathering metrics at block ${endBlock}`);
  
  // Essential queries only for better performance
  const queries = [
    atEnd.query.domains.domainStakingSummary(DOMAIN_ID),
    atEnd.query.domains.domainRegistry(DOMAIN_ID),
    atEnd.query.domains.accumulatedTreasuryFunds(),
    atEnd.query.domains.domainChainRewards(DOMAIN_ID),
    atEnd.query.domains.pendingStakingOperationCount(DOMAIN_ID),
    atEnd.query.domains.headDomainNumber(DOMAIN_ID),
    atEnd.query.domains.headReceiptNumber(DOMAIN_ID),
    atEnd.query.domains.newAddedHeadReceipt(DOMAIN_ID)
  ];
  
  // Add lightweight collection queries if not in lightweight mode
  if (!LIGHTWEIGHT) {
    queries.push(
      atEnd.query.domains.deposits.entries(),
      atEnd.query.domains.withdrawals.entries(),
      atEnd.query.domains.operators.entries()
    );
  }
  
  const results = await Promise.all(queries);
  
  const [
    domainStakingSummary, domainRegistry, accumulatedTreasuryFunds, domainChainRewards,
    pendingStakingOperationCount, headDomainNumber, headReceiptNumber, newAddedHeadReceipt,
    ...collectionResults
  ] = results;
  
  // Calculate totals from operators if available
  let totalStorageFeeDeposit = 0;
  let totalStake = 0;
  let totalShares = 0;
  let operatorCount = 0;
  
  if (!LIGHTWEIGHT && collectionResults.length >= 3) {
    const operators = collectionResults[2];
    operatorCount = operators.length;
    
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
  }
  
  const metrics = {
    epoch,
    endBlock,
    endHash: endHash.toString(),
    timestamp: Date.now(),
    
    // Essential metrics
    domainStakingSummary: domainStakingSummary?.unwrap?.()?.toHuman?.() || domainStakingSummary?.toString(),
    domainRegistry: domainRegistry?.unwrap?.()?.toHuman?.() || domainRegistry?.toString(),
    accumulatedTreasuryFunds: accumulatedTreasuryFunds?.toString(),
    domainChainRewards: domainChainRewards?.toString(),
    pendingStakingOperationCount: pendingStakingOperationCount?.toString(),
    headDomainNumber: headDomainNumber?.toString(),
    headReceiptNumber: headReceiptNumber?.toString(),
    newAddedHeadReceipt: newAddedHeadReceipt?.toString(),
    
    // Financial totals
    totalStorageFeeDeposit: totalStorageFeeDeposit.toString(),
    totalStake: totalStake.toString(),
    totalShares: totalShares.toString(),
    operatorCount
  };
  
  // Add collection counts if not in lightweight mode
  if (!LIGHTWEIGHT && collectionResults.length >= 3) {
    const [deposits, withdrawals] = collectionResults;
    metrics.deposits = { count: deposits.length };
    metrics.withdrawals = { count: withdrawals.length };
  }
  
  return metrics;
}

// Optimized worker function
async function processEpochBatch(pool, dbManager, epochs) {
  const api = await pool.getConnection();
  const results = [];
  
  try {
    for (const epoch of epochs) {
      try {
        const startBlock = await findEpochStartBlock(api, epoch);
        const nextStart = await findEpochStartBlock(api, epoch + 1);
        const endBlock = nextStart - 1;
        
        const metrics = await getOptimizedMetrics(api, epoch, endBlock);
        await dbManager.saveEpoch(epoch, endBlock, metrics.endHash, metrics);
        
        results.push(metrics);
        console.log(`[epoch.${epoch}] ✅ completed`);
        
      } catch (e) {
        console.error(`[epoch.${epoch}.error] ${e.message}`);
      }
    }
  } finally {
    pool.releaseConnection(api);
  }
  
  return results;
}

async function main() {
  console.log(`[connect] ${WS}`);
  console.log(`[config] domain=${DOMAIN_ID}, concurrency=${CONCURRENCY}, batch-size=${BATCH_SIZE}`);
  console.log(`[mode] ${LIGHTWEIGHT ? 'Lightweight' : 'Full'} mode`);

  let pool, dbManager;
  
  try {
    // Initialize connection pool
    pool = new OptimizedConnectionPool(WS, RPC_USER, RPC_PASS, CONCURRENCY);
    await pool.initialize();

    // Initialize database
    dbManager = new OptimizedDatabaseManager(DB_PATH);
    await dbManager.initialize();

    // Test connection and get current epoch
    const testApi = await pool.getConnection();
    try {
      const head = await testApi.rpc.chain.getHeader();
      console.log(`[connected] block #${head.number.toNumber()} • hash: ${head.hash.toString()}`);
      
      const headEpoch = await findEpochAt(testApi, head.number.toNumber());
      console.log(`[head] epoch ${headEpoch}`);
    } finally {
      pool.releaseConnection(testApi);
    }

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
    const processed = await dbManager.getProcessedEpochs();
    const existingEpochs = new Set(processed);

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

    // Process epochs in batches with better concurrency
    const results = [];
    const startTime = Date.now();
    
    for (let i = 0; i < epochsToProcess.length; i += BATCH_SIZE) {
      const batch = epochsToProcess.slice(i, i + BATCH_SIZE);
      console.log(`[batch] processing epochs ${batch[0]} to ${batch[batch.length - 1]} (${batch.length} epochs)`);
      
      const batchResults = await processEpochBatch(pool, dbManager, batch);
      results.push(...batchResults);
      
      const elapsed = Date.now() - startTime;
      const processed = results.length;
      const remaining = epochsToProcess.length - processed;
      const rate = processed / (elapsed / 1000);
      const eta = remaining / rate;
      
      console.log(`[progress] ${processed}/${epochsToProcess.length} epochs (${(processed/epochsToProcess.length*100).toFixed(1)}%)`);
      console.log(`[stats] Rate: ${rate.toFixed(2)} epochs/sec, ETA: ${(eta/60).toFixed(1)} minutes`);
    }

    console.log(`[complete] ${results.length} epochs saved to database`);

  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
    if (dbManager) await dbManager.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
