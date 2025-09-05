import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node backfill-comprehensive-metrics.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com/ws)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'current' (default: current)
  --out <path>         Output file path (default: public/data/comprehensive-metrics.json)
  --db <path>          SQLite database path (default: public/data/comprehensive-metrics.db)
  --concurrency <n>    Number of concurrent workers (default: 5)
  --batch-size <n>     Number of epochs to process in each batch (default: 10)
  --retries <n>        Number of retries for failed requests (default: 3)
  --timeout <ms>       Request timeout in milliseconds (default: 30000)
  --resume             Resume from last processed epoch
  --append             Append to existing output file instead of overwriting (JSON mode only)
  --help, -h           Show this help message

Environment Variables:
  RPC_URL_WS           WebSocket RPC endpoint (overrides --ws)
  RPC_USER             RPC username (overrides --user)
  RPC_PASS             RPC password (overrides --pass)
  DOMAIN               Domain ID (overrides --domain)
  FROM                 Starting epoch (overrides --from)
  TO                   Ending epoch (overrides --to)
  OUT                  Output file path (overrides --out)
  DB_PATH              Database path (overrides --db)
  CONCURRENCY          Number of workers (overrides --concurrency)
  BATCH_SIZE           Batch size (overrides --batch-size)

Examples:
  # Use database mode (recommended)
  node backfill-comprehensive-metrics.mjs --ws ws://192.168.0.99:9944 --domain 0 --db --concurrency 10 --batch-size 20 --resume

  # Use JSON mode (legacy)
  node backfill-comprehensive-metrics.mjs --domain 0 --append

  # High-performance setup
  node backfill-comprehensive-metrics.mjs --domain 0 --concurrency 10 --batch-size 20

  # Resume interrupted backfill
  node backfill-comprehensive-metrics.mjs --domain 0 --resume

  # Use environment variables
  export RPC_USER=your_username
  export RPC_PASS=your_password
  export CONCURRENCY=8
  node backfill-comprehensive-metrics.mjs --domain 0
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
const OUT = getArg('out', 'public/data/comprehensive-metrics.json');
const DB_PATH = getArg('db', 'public/data/comprehensive-metrics.db');
const CONCURRENCY = Number(getArg('concurrency', '5'));
const BATCH_SIZE = Number(getArg('batch-size', '10'));
const RETRIES = Number(getArg('retries', '3'));
const TIMEOUT = Number(getArg('timeout', '30000'));
const RESUME = argv.includes('--resume');
const APPEND = argv.includes('--append');
const USE_DB = argv.includes('--db') || DB_PATH !== 'public/data/comprehensive-metrics.db';

// Database schema
const SCHEMA = `
CREATE TABLE IF NOT EXISTS epochs (
  epoch INTEGER PRIMARY KEY,
  end_block INTEGER NOT NULL,
  end_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epochs_epoch ON epochs(epoch);
CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs(timestamp);
CREATE INDEX IF NOT EXISTS idx_epochs_created_at ON epochs(created_at);
`;

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

function mapToObj(m) {
  if (!m) return {};
  const out = {};
  for (const [k, v] of m.entries()) {
    const key = k.args.map(a => a.toString()).join(',');
    out[key] = v?.toString?.() || JSON.stringify(v);
  }
  return out;
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
    try {
      // Try with updated_at column first
      const stmt = await this.db.prepare(
        'INSERT OR REPLACE INTO epochs (epoch, end_block, end_hash, timestamp, data, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
      );
      await stmt.run(epoch, endBlock, endHash, Date.now(), JSON.stringify(data));
      await stmt.finalize();
    } catch (e) {
      if (e.message.includes('no column named updated_at')) {
        // Fallback for older schema without updated_at column
        const stmt = await this.db.prepare(
          'INSERT OR REPLACE INTO epochs (epoch, end_block, end_hash, timestamp, data) VALUES (?, ?, ?, ?, ?)'
        );
        await stmt.run(epoch, endBlock, endHash, Date.now(), JSON.stringify(data));
        await stmt.finalize();
      } else {
        throw e;
      }
    }
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

  async exportToJson(outputPath) {
    const rows = await this.db.all('SELECT data FROM epochs ORDER BY epoch');
    const data = rows.map(row => JSON.parse(row.data));
    ensureDir(outputPath);
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    console.log(`[export] ${data.length} epochs exported to ${outputPath}`);
  }

  async close() {
    if (this.db) {
      await this.db.close();
    }
  }
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
    consensusBlockHash, deposits, withdrawals, depositOnHold, successfulBundles,
    operatorEpochSharePrice, operatorHighestSlot, operatorBundleSlot, pendingSlashes,
    lastEpochStakingDistribution, invalidBundleAuthors, latestConfirmedDomainExecutionReceipt,
    domainGenesisBlockExecutionReceipt, latestSubmittedER, operators
  ] = results;
  
  // Calculate storage fee deposits from operators
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
    consensusBlockHash: consensusBlockHash?.toString(),
    
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
    }
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
        
        const metrics = await getComprehensiveMetrics(api, epoch, endBlock);
        
        if (USE_DB) {
          await dbManager.saveEpoch(epoch, endBlock, metrics.endHash, metrics);
        }
        
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

async function main() {
  console.log(`[connect] ${WS}`);
  console.log(`[config] domain=${DOMAIN_ID}, concurrency=${CONCURRENCY}, batch-size=${BATCH_SIZE}`);
  console.log(`[mode] ${USE_DB ? 'Database' : 'JSON'} mode`);

  let pool, dbManager;
  
  try {
    // Initialize connection pool
    pool = new ConnectionPool(WS, RPC_USER, RPC_PASS, CONCURRENCY);
    await pool.initialize();

    // Initialize database if using DB mode
    if (USE_DB) {
      dbManager = new DatabaseManager(DB_PATH);
      await dbManager.initialize();
    }

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
    if (RESUME && USE_DB) {
      const lastProcessed = await dbManager.getLastProcessedEpoch();
      if (lastProcessed >= 0) {
        fromEpoch = lastProcessed + 1;
        console.log(`[resume] continuing from epoch ${fromEpoch} (last processed: ${lastProcessed})`);
      }
    }
    
    console.log(`[range] epochs ${fromEpoch} to ${toEpoch}`);

    // Get already processed epochs
    let existingEpochs = new Set();
    if (USE_DB) {
      const processed = await dbManager.getProcessedEpochs();
      existingEpochs = new Set(processed);
    } else if (APPEND && fs.existsSync(OUT)) {
      try {
        const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
        existingEpochs = new Set(existing.map(e => e.epoch));
        console.log(`[append] loaded ${existing.length} existing epochs`);
      } catch (e) {
        console.warn(`[append] failed to load existing data: ${e.message}`);
      }
    }

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
      
      // Save progress for JSON mode
      if (!USE_DB && (i + BATCH_SIZE >= epochsToProcess.length || (i / BATCH_SIZE + 1) % 5 === 0)) {
        const allResults = APPEND && fs.existsSync(OUT) 
          ? [...JSON.parse(fs.readFileSync(OUT, 'utf8')), ...results]
          : results;
        ensureDir(OUT);
        fs.writeFileSync(OUT, JSON.stringify(allResults, null, 2));
        console.log(`[save] ${allResults.length} epochs saved to ${OUT}`);
      }
    }

    // Final save
    if (USE_DB) {
      console.log(`[complete] ${results.length} epochs saved to database`);
      // Export to JSON if requested
      if (OUT !== 'public/data/comprehensive-metrics.json') {
        await dbManager.exportToJson(OUT);
      }
    } else {
      const allResults = APPEND && fs.existsSync(OUT) 
        ? [...JSON.parse(fs.readFileSync(OUT, 'utf8')), ...results]
        : results;
      ensureDir(OUT);
      fs.writeFileSync(OUT, JSON.stringify(allResults, null, 2));
      console.log(`[complete] ${allResults.length} epochs saved to ${OUT}`);
    }

  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
    if (dbManager) await dbManager.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
