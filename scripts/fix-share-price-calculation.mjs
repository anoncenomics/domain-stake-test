#!/usr/bin/env node

/**
 * Fix Share Price Calculation
 * Recalculate share prices using the correct formula: stake/shares
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

async function fixSharePrices() {
  console.log('🔧 Fixing Share Price Calculations\n');
  console.log('═══════════════════════════════════════\n');
  
  const pool = new Pool(PG_CONFIG);
  
  try {
    const client = await pool.connect();
    
    try {
      // First, let's understand what we're dealing with
      console.log('📊 Current State Analysis:\n');
      
      // Check real operators (0-3) data
      const operatorQuery = await client.query(`
        SELECT 
          os.operator_id,
          os.epoch,
          os.stake_raw,
          os.shares_raw,
          osp.share_price_perq as current_price,
          CASE 
            WHEN os.shares_raw > 0 
            THEN (os.stake_raw::NUMERIC * 1e18 / os.shares_raw::NUMERIC)::BIGINT
            ELSE 1000000000000000000
          END as correct_price
        FROM operator_shares os
        JOIN operator_share_prices osp ON os.epoch = osp.epoch AND os.operator_id = osp.operator_id
        WHERE os.operator_id <= 3 
        AND os.epoch IN (100, 1000, 2000, 3000)
        ORDER BY os.epoch, os.operator_id
        LIMIT 12
      `);
      
      console.log('Sample of Real Operators (IDs 0-3):');
      console.log('Epoch | Op | Current Price | Correct Price | Difference');
      console.log('------|----|--------------|--------------|-----------');
      
      for (const row of operatorQuery.rows) {
        const current = BigInt(row.current_price);
        const correct = BigInt(row.correct_price);
        const diff = Number((correct - current) * 100n / current) / 100;
        console.log(
          `${String(row.epoch).padEnd(5)} | ${String(row.operator_id).padEnd(2)} | ` +
          `${(Number(current) / 1e18).toFixed(6).padEnd(12)} | ` +
          `${(Number(correct) / 1e18).toFixed(6).padEnd(12)} | ` +
          `${diff > 0 ? '+' : ''}${diff.toFixed(4)}%`
        );
      }
      console.log('');
      
      // Now let's fix the calculation for real operators
      console.log('🔄 Recalculating Share Prices for Real Operators...\n');
      
      // Update share prices based on stake/shares calculation
      const updateResult = await client.query(`
        UPDATE operator_share_prices osp
        SET 
          share_price_perq = CASE 
            WHEN os.shares_raw > 0 
            THEN (os.stake_raw::NUMERIC * 1e18 / os.shares_raw::NUMERIC)::NUMERIC(40,0)
            ELSE 1000000000000000000
          END,
          source = 'recalculated_stake_shares',
          updated_at = NOW()
        FROM operator_shares os
        WHERE osp.epoch = os.epoch 
        AND osp.operator_id = os.operator_id
        AND os.operator_id <= 3  -- Only update real operators for now
      `);
      
      console.log(`✅ Updated ${updateResult.rowCount} operator share price records\n`);
      
      // Verify the fix
      console.log('🔍 Verification:\n');
      
      const verifyQuery = await client.query(`
        SELECT 
          os.operator_id,
          COUNT(*) as epochs_count,
          MIN(osp.share_price_perq / 1e18) as min_price,
          MAX(osp.share_price_perq / 1e18) as max_price,
          AVG(osp.share_price_perq / 1e18) as avg_price,
          STDDEV(osp.share_price_perq / 1e18) as stddev_price
        FROM operator_shares os
        JOIN operator_share_prices osp ON os.epoch = osp.epoch AND os.operator_id = osp.operator_id
        WHERE os.operator_id <= 3
        GROUP BY os.operator_id
        ORDER BY os.operator_id
      `);
      
      console.log('Updated Operator Statistics:');
      console.log('Op | Epochs | Min Price | Max Price | Avg Price | Std Dev');
      console.log('---|--------|-----------|-----------|-----------|--------');
      
      for (const row of verifyQuery.rows) {
        console.log(
          `${String(row.operator_id).padEnd(2)} | ` +
          `${String(row.epochs_count).padEnd(6)} | ` +
          `${Number(row.min_price).toFixed(6).padEnd(9)} | ` +
          `${Number(row.max_price).toFixed(6).padEnd(9)} | ` +
          `${Number(row.avg_price).toFixed(6).padEnd(9)} | ` +
          `${Number(row.stddev_price).toFixed(6)}`
        );
      }
      console.log('');
      
      // Check what the nominator positions look like
      console.log('📌 Nominator Position Analysis:\n');
      
      const nominatorQuery = await client.query(`
        WITH nominator_stats AS (
          SELECT 
            operator_id,
            COUNT(*) as count,
            MIN(share_price_perq / 1e18) as min_price,
            MAX(share_price_perq / 1e18) as max_price
          FROM operator_share_prices
          WHERE operator_id > 3
          AND epoch = 1000
          GROUP BY operator_id
          ORDER BY operator_id
          LIMIT 20
        )
        SELECT 
          COUNT(*) as total_nominators,
          MIN(min_price) as overall_min,
          MAX(max_price) as overall_max
        FROM nominator_stats
      `);
      
      const nomStats = nominatorQuery.rows[0];
      console.log(`Total Nominator Positions at Epoch 1000: ${nomStats.total_nominators}`);
      console.log(`Price Range: ${Number(nomStats.overall_min).toFixed(6)} - ${Number(nomStats.overall_max).toFixed(6)}`);
      console.log('');
      
      console.log('💡 Recommendations:\n');
      console.log('1. The tables should be renamed to reflect their true purpose:');
      console.log('   - operator_share_prices → nominator_share_prices');
      console.log('   - operator_shares → operator_stakes_and_shares');
      console.log('');
      console.log('2. Create separate views or queries for:');
      console.log('   - Real operators (IDs 0-3)');
      console.log('   - Nominator positions (IDs > 3)');
      console.log('');
      console.log('3. The hex values in operatorEpochSharePrice likely encode:');
      console.log('   - Nominator account address');
      console.log('   - Operator ID they\'re delegating to');
      console.log('   - Possibly epoch or position ID');
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('❌ Fix failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

fixSharePrices()
  .then(() => {
    console.log('\n✨ Share price fix complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
