#!/usr/bin/env node

/**
 * Investigate what the "operator" IDs actually represent
 */

import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const { Pool } = pg;

const PG_CONFIG = {
  host: process.env.PG_HOST || 'aws-1-us-east-1.pooler.supabase.com',
  port: parseInt(process.env.PG_PORT || '6543'),
  database: process.env.PG_NAME || 'postgres',
  user: process.env.PG_USER || 'postgres.kaxlpwjlesmlfiawsfvy',
  password: process.env.PG_PASS?.replace(/"/g, '') || 'dl33D#YWGmrm0EKD%Lk7t$',
  max: 5
};

async function investigate() {
  console.log('🔍 Investigating "Operator" ID Mystery\n');
  console.log('═══════════════════════════════════════\n');
  
  const pool = new Pool(PG_CONFIG);
  
  try {
    const client = await pool.connect();
    
    try {
      // 1. Check a sample epoch's data structure
      console.log('📊 Analyzing Epoch 1000 Data Structure:\n');
      
      const structureQuery = await client.query(`
        SELECT 
          jsonb_array_length(data->'operators'->'entries') as real_operators_count,
          (data->'operators'->>'count')::INT as operators_count_field,
          jsonb_array_length(data->'operatorEpochSharePrice'->'entries') as share_price_entries,
          jsonb_array_length(data->'deposits'->'entries') as deposits_count,
          jsonb_array_length(data->'withdrawals'->'entries') as withdrawals_count,
          (data->'domainStakingSummary'->'currentOperators')::jsonb ? '0' as has_operator_0,
          (data->'domainStakingSummary'->'currentOperators')::jsonb ? '1' as has_operator_1,
          (data->'domainStakingSummary'->'currentOperators')::jsonb ? '2' as has_operator_2,
          (data->'domainStakingSummary'->'currentOperators')::jsonb ? '3' as has_operator_3
        FROM epochs 
        WHERE epoch = 1000
      `);
      
      const stats = structureQuery.rows[0];
      console.log(`  Real Operators (operators.entries): ${stats.real_operators_count}`);
      console.log(`  Operators Count Field: ${stats.operators_count_field}`);
      console.log(`  Share Price Entries: ${stats.share_price_entries}`);
      console.log(`  Deposits: ${stats.deposits_count}`);
      console.log(`  Withdrawals: ${stats.withdrawals_count}`);
      console.log(`  Has Operator 0-3: ${[0,1,2,3].map(i => stats[`has_operator_${i}`]).join(', ')}\n`);
      
      // 2. Sample the operatorEpochSharePrice entries
      console.log('🔬 Sample operatorEpochSharePrice Entries:\n');
      
      const sampleQuery = await client.query(`
        SELECT 
          e->>'key' as key,
          e->>'value' as value,
          LENGTH(split_part(e->>'value', ',', 1)) as hex_length
        FROM epochs,
        LATERAL jsonb_array_elements(data->'operatorEpochSharePrice'->'entries') e
        WHERE epoch = 1000
        LIMIT 5
      `);
      
      for (const row of sampleQuery.rows) {
        console.log(`  Key: ${row.key}`);
        const [hex, price] = row.value.split(',');
        console.log(`    Hex (${row.hex_length} chars): ${hex.substring(0, 20)}...`);
        console.log(`    Price: ${price}`);
        
        // Try to decode the hex
        if (hex.startsWith('0x')) {
          const cleanHex = hex.substring(2);
          // The hex might encode: [operator_id][nominator_account][epoch] or similar
          console.log(`    First 8 chars: ${cleanHex.substring(0, 8)}`);
          console.log(`    Last 8 chars: ${cleanHex.substring(cleanHex.length - 8)}`);
        }
        console.log('');
      }
      
      // 3. Check if these IDs correlate with deposits
      console.log('📈 Correlation Analysis:\n');
      
      const correlationQuery = await client.query(`
        WITH epoch_stats AS (
          SELECT 
            epoch,
            jsonb_array_length(data->'operatorEpochSharePrice'->'entries') as share_price_count,
            jsonb_array_length(data->'deposits'->'entries') as deposits_count,
            jsonb_array_length(data->'withdrawals'->'entries') as withdrawals_count,
            (data->'operators'->>'count')::INT as operators_count
          FROM epochs
          WHERE epoch BETWEEN 900 AND 1100
        )
        SELECT 
          MIN(share_price_count) as min_entries,
          MAX(share_price_count) as max_entries,
          AVG(share_price_count)::INT as avg_entries,
          SUM(deposits_count) as total_deposits,
          SUM(withdrawals_count) as total_withdrawals,
          MAX(operators_count) as max_operators
        FROM epoch_stats
      `);
      
      const corr = correlationQuery.rows[0];
      console.log(`  Share Price Entry Range: ${corr.min_entries} - ${corr.max_entries} (avg: ${corr.avg_entries})`);
      console.log(`  Total Deposits (epochs 900-1100): ${corr.total_deposits}`);
      console.log(`  Total Withdrawals (epochs 900-1100): ${corr.total_withdrawals}`);
      console.log(`  Max Operators: ${corr.max_operators}\n`);
      
      // 4. Check pattern over time
      console.log('📅 Growth Pattern:\n');
      
      const growthQuery = await client.query(`
        SELECT 
          epoch,
          jsonb_array_length(data->'operatorEpochSharePrice'->'entries') as entry_count
        FROM epochs
        WHERE epoch % 100 = 0
        ORDER BY epoch
        LIMIT 20
      `);
      
      console.log('  Epoch | Entry Count');
      console.log('  ------|------------');
      for (const row of growthQuery.rows) {
        console.log(`  ${String(row.epoch).padEnd(5)} | ${row.entry_count}`);
      }
      console.log('');
      
      // 5. Check if the hex encodes account information
      console.log('🔐 Hex Pattern Analysis:\n');
      
      const hexPatternQuery = await client.query(`
        WITH hex_data AS (
          SELECT 
            split_part(e->>'value', ',', 1) as hex_value,
            e->>'key' as id_key
          FROM epochs,
          LATERAL jsonb_array_elements(data->'operatorEpochSharePrice'->'entries') e
          WHERE epoch = 1000
          LIMIT 100
        )
        SELECT 
          COUNT(DISTINCT hex_value) as unique_hexes,
          COUNT(DISTINCT id_key) as unique_ids,
          COUNT(*) as total_entries,
          MIN(LENGTH(hex_value)) as min_hex_length,
          MAX(LENGTH(hex_value)) as max_hex_length
        FROM hex_data
      `);
      
      const hexPattern = hexPatternQuery.rows[0];
      console.log(`  Unique Hex Values: ${hexPattern.unique_hexes}`);
      console.log(`  Unique ID Keys: ${hexPattern.unique_ids}`);
      console.log(`  Total Entries: ${hexPattern.total_entries}`);
      console.log(`  Hex Length Range: ${hexPattern.min_hex_length} - ${hexPattern.max_hex_length} chars\n`);
      
      // 6. Final hypothesis
      console.log('💡 Hypothesis:\n');
      console.log('  Based on the data:');
      console.log('  - These IDs likely represent individual NOMINATOR positions, not operators');
      console.log('  - Each ID tracks a specific stake/delegation from a nominator to an operator');
      console.log('  - The hex value might encode: [nominator_account][operator_id][other_data]');
      console.log('  - Share prices of 1.0 suggest these are initial positions or normalized values');
      console.log('  - The growing count over time matches accumulation of unique staking positions\n');
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('❌ Investigation failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

investigate()
  .then(() => {
    console.log('🎉 Investigation complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
