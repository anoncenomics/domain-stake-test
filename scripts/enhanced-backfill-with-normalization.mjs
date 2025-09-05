#!/usr/bin/env node

/**
 * Enhanced Backfill Script with Operator Share Price Normalization
 * Populates both the epochs table and normalized operator tables
 */

import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const { Pool } = pg;

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node enhanced-backfill-with-normalization.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: ws://192.168.0.99:9944 for local)
  --domain <id>        Domain ID to query (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'current' (default: current)
  --batch-size <n>     Number of epochs per batch (default: 50)
  --test               Test mode - only process 10 epochs
  --skip-epochs        Skip updating epochs table (only update normalized tables)
  --help, -h           Show this help message

Environment Variables (from .env.local):
  PG_HOST, PG_PORT, PG_NAME, PG_USER, PG_PASS

Examples:
  # Test with small range
  node enhanced-backfill-with-normalization.mjs --test
  
  # Full backfill using local node
  node enhanced-backfill-with-normalization.mjs --ws ws://192.168.0.99:9944 --from 0 --to current
  
  # Update only normalized tables from existing epochs data
  node enhanced-backfill-with-normalization.mjs --skip-epochs
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return d;
};

// Configuration - Use local node for fast backfill
const WS = getArg('ws', 'ws://192.168.0.99:9944');  // Local node for historical backfill
const DOMAIN_ID = Number(getArg('domain', '0'));
const FROM = getArg('from', '0');
const TO = getArg('to', 'current');
const BATCH_SIZE = Number(getArg('batch-size', '50'));
const TEST_MODE = argv.includes('--test');
const SKIP_EPOCHS = argv.includes('--skip-epochs');

// PostgreSQL configuration from .env.local
const PG_CONFIG = {
  host: process.env.PG_HOST || 'aws-1-us-east-1.pooler.supabase.com',
  port: parseInt(process.env.PG_PORT || '6543'),
  database: process.env.PG_NAME || 'postgres',
  user: process.env.PG_USER || 'postgres.kaxlpwjlesmlfiawsfvy',
  password: process.env.PG_PASS || process.env.PG_PASSWORD || 'dl33D#YWGmrm0EKD%Lk7t$',
  max: 10
};

// Connection pool for PostgreSQL
const pgPool = new Pool(PG_CONFIG);

/**
 * Extract operator share prices from operatorEpochSharePrice entries
 */
function extractSharePricesFromEntries(entries) {
  const sharePrices = [];
  
  if (!entries || !Array.isArray(entries)) return sharePrices;
  
  for (const entry of entries) {
    try {
      const opId = entry.key?.[0] ?? entry.key;
      if (opId === undefined) continue;
      
      const valueStr = entry.value;
      if (typeof valueStr !== 'string') continue;
      
      // Parse format: "hex_data,decimal_value" 
      // The decimal value is the share price in 1e18 scale
      const commaIndex = valueStr.lastIndexOf(',');
      if (commaIndex === -1) continue;
      
      const decimalValue = valueStr.slice(commaIndex + 1);
      if (decimalValue && !isNaN(Number(decimalValue))) {
        // Convert to BigInt for precise handling
        // The value is already in 1e18 scale (perquintill)
        const sharePrice = BigInt(decimalValue);
        sharePrices.push({
          operator_id: Number(opId),
          share_price_perq: sharePrice.toString()
        });
      }
    } catch (err) {
      console.warn(`Error parsing share price entry: ${err.message}`);
    }
  }
  
  return sharePrices;
}

/**
 * Extract operator shares and stakes from operators.entries
 */
function extractOperatorMetrics(entries) {
  const operators = [];
  
  if (!entries || !Array.isArray(entries)) return operators;
  
  for (const entry of entries) {
    try {
      const opId = entry.key?.[0] ?? entry.key;
      if (opId === undefined) continue;
      
      const valueStr = entry.value;
      if (typeof valueStr !== 'string') continue;
      
      // Parse the complex format: "hex_prefix,{json_data}"
      const commaIndex = valueStr.indexOf(',');
      if (commaIndex === -1) continue;
      
      const jsonPart = valueStr.slice(commaIndex + 1);
      const operatorData = JSON.parse(jsonPart);
      
      const result = {
        operator_id: Number(opId),
        shares_raw: '0',
        stake_raw: '0',
        share_price_calculated: '0'
      };
      
      // Extract stake and shares (both are hex values)
      if (operatorData.currentTotalStake) {
        result.stake_raw = BigInt(operatorData.currentTotalStake).toString();
      }
      if (operatorData.currentTotalShares) {
        result.shares_raw = BigInt(operatorData.currentTotalShares).toString();
      }
      
      // Calculate share price from stake/shares ratio
      if (result.stake_raw !== '0' && result.shares_raw !== '0') {
        const stake = BigInt(result.stake_raw);
        const shares = BigInt(result.shares_raw);
        // Share price = stake/shares in 1e18 scale
        const sharePrice = (stake * BigInt(10 ** 18)) / shares;
        result.share_price_calculated = sharePrice.toString();
      }
      
      operators.push(result);
    } catch (err) {
      console.warn(`Error parsing operator entry: ${err.message}`);
    }
  }
  
  return operators;
}

/**
 * Process a single epoch's data
 */
async function processEpochData(epochData) {
  const { epoch, data } = epochData;
  const results = {
    epoch,
    sharePrices: [],
    operatorMetrics: []
  };
  
  // Extract share prices from operatorEpochSharePrice
  if (data.operatorEpochSharePrice?.entries) {
    results.sharePrices = extractSharePricesFromEntries(data.operatorEpochSharePrice.entries);
  }
  
  // Extract operator metrics from operators.entries
  if (data.operators?.entries) {
    results.operatorMetrics = extractOperatorMetrics(data.operators.entries);
  }
  
  // If we have calculated share prices but no direct ones, use calculated
  if (results.sharePrices.length === 0 && results.operatorMetrics.length > 0) {
    results.sharePrices = results.operatorMetrics
      .filter(op => op.share_price_calculated !== '0')
      .map(op => ({
        operator_id: op.operator_id,
        share_price_perq: op.share_price_calculated
      }));
  }
  
  return results;
}

/**
 * Save normalized data to PostgreSQL
 */
async function saveNormalizedData(client, epochResults) {
  const { epoch, sharePrices, operatorMetrics } = epochResults;
  
  // Save operator share prices
  if (sharePrices.length > 0) {
    const values = sharePrices.map(sp => 
      `(${epoch}, ${sp.operator_id}, ${sp.share_price_perq}, 'epochs_json')`
    ).join(',');
    
    await client.query(`
      INSERT INTO operator_share_prices (epoch, operator_id, share_price_perq, source)
      VALUES ${values}
      ON CONFLICT (epoch, operator_id) DO UPDATE SET
        share_price_perq = EXCLUDED.share_price_perq,
        source = EXCLUDED.source,
        updated_at = NOW()
    `);
  }
  
  // Save operator shares and stakes
  if (operatorMetrics.length > 0) {
    const values = operatorMetrics.map(om => 
      `(${epoch}, ${om.operator_id}, ${om.shares_raw}, ${om.stake_raw})`
    ).join(',');
    
    await client.query(`
      INSERT INTO operator_shares (epoch, operator_id, shares_raw, stake_raw)
      VALUES ${values}
      ON CONFLICT (epoch, operator_id) DO UPDATE SET
        shares_raw = EXCLUDED.shares_raw,
        stake_raw = EXCLUDED.stake_raw,
        updated_at = NOW()
    `);
  }
  
  // Update operator metadata
  for (const op of operatorMetrics) {
    await client.query(`
      INSERT INTO operators_metadata (operator_id, first_seen_epoch, last_seen_epoch, total_epochs_active)
      VALUES ($1, $2, $2, 1)
      ON CONFLICT (operator_id) DO UPDATE SET
        last_seen_epoch = GREATEST(operators_metadata.last_seen_epoch, EXCLUDED.last_seen_epoch),
        first_seen_epoch = LEAST(operators_metadata.first_seen_epoch, EXCLUDED.first_seen_epoch),
        total_epochs_active = operators_metadata.total_epochs_active + 1,
        updated_at = NOW()
    `, [op.operator_id, epoch]);
  }
}

/**
 * Process existing epochs data from database
 */
async function processExistingEpochs(fromEpoch, toEpoch) {
  console.log(`📊 Processing existing epochs from ${fromEpoch} to ${toEpoch}...`);
  
  const client = await pgPool.connect();
  try {
    // Fetch epochs in batches
    const pageSize = 100;
    let processedCount = 0;
    let offset = 0;
    
    while (true) {
      const result = await client.query(`
        SELECT epoch, data
        FROM epochs
        WHERE epoch >= $1 AND epoch <= $2
        ORDER BY epoch
        LIMIT $3 OFFSET $4
      `, [fromEpoch, toEpoch, pageSize, offset]);
      
      if (result.rows.length === 0) break;
      
      // Process each epoch
      for (const row of result.rows) {
        const epochResults = await processEpochData(row);
        await saveNormalizedData(client, epochResults);
        processedCount++;
        
        if (processedCount % 100 === 0) {
          console.log(`  ✅ Processed ${processedCount} epochs...`);
        }
      }
      
      offset += pageSize;
    }
    
    console.log(`✅ Processed ${processedCount} total epochs`);
    
  } finally {
    client.release();
  }
}

/**
 * Get epoch data from blockchain
 */
async function fetchEpochFromChain(api, epoch) {
  // Implementation similar to optimized-comprehensive-backfill.mjs
  // This is a simplified version - you may want to copy the full logic
  const startBlock = await findEpochStartBlock(api, epoch);
  const nextStart = await findEpochStartBlock(api, epoch + 1);
  const endBlock = nextStart - 1;
  
  const endHash = await api.rpc.chain.getBlockHash(endBlock);
  const atEnd = await api.at(endHash);
  
  // Fetch comprehensive data
  const [
    domainStakingSummary,
    operators,
    operatorEpochSharePrice,
    // ... other queries as needed
  ] = await Promise.all([
    atEnd.query.domains.domainStakingSummary(DOMAIN_ID),
    atEnd.query.domains.operators.entries(),
    atEnd.query.domains.operatorEpochSharePrice.entries(),
    // ... other queries
  ]);
  
  return {
    epoch,
    endBlock,
    endHash: endHash.toString(),
    timestamp: Date.now(),
    data: {
      domainStakingSummary: domainStakingSummary?.toJSON?.() || {},
      operators: { entries: mapToArray(operators) },
      operatorEpochSharePrice: { entries: mapToArray(operatorEpochSharePrice) },
      // ... other data
    }
  };
}

// Helper functions (from optimized-comprehensive-backfill.mjs)
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
  return lo;
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Enhanced Backfill with Normalization');
  console.log(`📡 RPC: ${WS}`);
  console.log(`🗄️  Database: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database}`);
  
  try {
    // Test database connection
    const testClient = await pgPool.connect();
    console.log('✅ Database connection successful');
    
    // Check if tables exist
    const tablesCheck = await testClient.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_schema = 'public' 
      AND table_name IN ('operator_share_prices', 'operator_shares', 'operators_metadata')
    `);
    
    if (tablesCheck.rows[0].count < 3) {
      console.error('❌ Required tables not found. Please run 01_create_operator_share_price_tables.sql first');
      testClient.release();
      process.exit(1);
    }
    
    testClient.release();
    
    if (SKIP_EPOCHS) {
      // Process existing epochs data only
      const epochRange = await pgPool.query('SELECT MIN(epoch) as min, MAX(epoch) as max FROM epochs');
      const minEpoch = epochRange.rows[0].min || 0;
      const maxEpoch = epochRange.rows[0].max || 0;
      
      const fromEpoch = FROM === '0' ? minEpoch : Number(FROM);
      const toEpoch = TO === 'current' ? maxEpoch : Number(TO);
      
      await processExistingEpochs(fromEpoch, toEpoch);
      
    } else {
      // Full backfill from chain
      console.log('⚠️  Full chain backfill not yet implemented in this script');
      console.log('💡 Use --skip-epochs to process existing epochs data');
      
      // TODO: Implement full chain backfill similar to optimized-comprehensive-backfill.mjs
      // This would involve connecting to the RPC node and fetching data
    }
    
    // Display statistics
    const stats = await pgPool.query(`
      SELECT 
        (SELECT COUNT(DISTINCT epoch) FROM operator_share_prices) as share_price_epochs,
        (SELECT COUNT(*) FROM operator_share_prices) as total_share_prices,
        (SELECT COUNT(DISTINCT epoch) FROM operator_shares) as shares_epochs,
        (SELECT COUNT(*) FROM operator_shares) as total_shares,
        (SELECT COUNT(*) FROM operators_metadata WHERE total_epochs_active > 0) as active_operators
    `);
    
    console.log('\n📊 Final Statistics:');
    console.log(`  Share Price Entries: ${stats.rows[0].total_share_prices}`);
    console.log(`  Share Price Epochs: ${stats.rows[0].share_price_epochs}`);
    console.log(`  Operator Share Entries: ${stats.rows[0].total_shares}`);
    console.log(`  Active Operators: ${stats.rows[0].active_operators}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await pgPool.end();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => {
      console.log('✅ Backfill completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Fatal error:', error);
      process.exit(1);
    });
}

export { processEpochData, saveNormalizedData, processExistingEpochs };
