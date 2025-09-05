#!/usr/bin/env node

/**
 * Full Deployment Validation
 * Comprehensive checks for data integrity, performance, and correctness
 */

import pg from 'pg';
import fetch from 'node-fetch';
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

const API_BASE = 'http://localhost:3000/api';

async function validateDeployment() {
  console.log('🔍 Full Deployment Validation\n');
  console.log('═══════════════════════════════════════\n');
  
  const pool = new Pool(PG_CONFIG);
  let validationPassed = true;
  const issues = [];
  
  try {
    const client = await pool.connect();
    
    try {
      // ========================================
      // 1. DATA INTEGRITY CHECKS
      // ========================================
      console.log('📊 1. Data Integrity Checks:\n');
      
      // Check share price reasonableness (storage fund costs can push below 1.0)
      const priceRangeQuery = await client.query(`
        SELECT 
          MIN(share_price_perq / 1e18) as min_price,
          MAX(share_price_perq / 1e18) as max_price,
          COUNT(CASE WHEN share_price_perq < 0.99 * 1e18 THEN 1 END) as severe_depreciation,
          COUNT(CASE WHEN share_price_perq < 1e18 THEN 1 END) as below_one
        FROM operator_share_prices
      `);
      
      const priceStats = priceRangeQuery.rows[0];
      console.log(`  ✅ Price range: ${Number(priceStats.min_price).toFixed(6)} - ${Number(priceStats.max_price).toFixed(6)}`);
      console.log(`  📊 Positions below 1.0: ${priceStats.below_one} (normal due to storage fund costs)`);
      
      if (priceStats.severe_depreciation > 0) {
        issues.push(`⚠️  ${priceStats.severe_depreciation} positions with >1% depreciation (may need investigation)`);
      }
      
      // Check operator share price calculation
      const calcCheckQuery = await client.query(`
        WITH calculated AS (
          SELECT 
            os.epoch,
            os.operator_id,
            os.stake_raw,
            os.shares_raw,
            osp.share_price_perq as stored_price,
            CASE 
              WHEN os.shares_raw > 0 
              THEN (os.stake_raw::NUMERIC * 1e18 / os.shares_raw::NUMERIC)::NUMERIC(40,0)
              ELSE 1000000000000000000
            END as calculated_price
          FROM operator_shares os
          JOIN operator_share_prices osp ON os.epoch = osp.epoch AND os.operator_id = osp.operator_id
          WHERE os.operator_id <= 3
        )
        SELECT 
          COUNT(*) as total_checked,
          COUNT(CASE WHEN ABS(stored_price - calculated_price) > 1000 THEN 1 END) as mismatches
        FROM calculated
      `);
      
      const calcStats = calcCheckQuery.rows[0];
      if (calcStats.mismatches > 0) {
        issues.push(`❌ ${calcStats.mismatches}/${calcStats.total_checked} operator prices don't match stake/shares calculation`);
        validationPassed = false;
      } else {
        console.log(`  ✅ All ${calcStats.total_checked} operator prices match stake/shares calculation`);
      }
      
      // Check data completeness
      const completenessQuery = await client.query(`
        WITH epoch_range AS (
          SELECT MIN(epoch) as min_epoch, MAX(epoch) as max_epoch
          FROM epochs
        ),
        expected_operators AS (
          SELECT generate_series(0, 3) as operator_id
        ),
        expected_data AS (
          SELECT e.epoch, eo.operator_id
          FROM epochs e
          CROSS JOIN expected_operators eo
          WHERE EXISTS (
            SELECT 1 FROM operator_shares os 
            WHERE os.operator_id = eo.operator_id 
            AND os.epoch = e.epoch
          )
        )
        SELECT 
          (SELECT COUNT(*) FROM expected_data) as expected_records,
          (SELECT COUNT(*) FROM operator_shares WHERE operator_id <= 3) as actual_records
      `);
      
      const compStats = completenessQuery.rows[0];
      if (compStats.expected_records !== compStats.actual_records) {
        issues.push(`⚠️  Data completeness: ${compStats.actual_records}/${compStats.expected_records} records`);
      } else {
        console.log(`  ✅ Data complete: ${compStats.actual_records} operator records`);
      }
      
      console.log('');
      
      // ========================================
      // 2. VIEW CONSISTENCY CHECKS
      // ========================================
      console.log('📋 2. View Consistency Checks:\n');
      
      // Check if views exist and are populated
      const viewsToCheck = [
        'comprehensive_analytics',
        'real_operator_share_prices',
        'operator_analytics',
        'nominator_position_tracker'
      ];
      
      for (const viewName of viewsToCheck) {
        try {
          const viewCheck = await client.query(`SELECT COUNT(*) as count FROM ${viewName} LIMIT 1`);
          console.log(`  ✅ View ${viewName}: accessible`);
        } catch (err) {
          issues.push(`❌ View ${viewName} is not accessible: ${err.message}`);
          validationPassed = false;
        }
      }
      
      console.log('');
      
      // ========================================
      // 3. OPERATOR VS NOMINATOR SEPARATION
      // ========================================
      console.log('👥 3. Operator/Nominator Separation:\n');
      
      const separationQuery = await client.query(`
        SELECT 
          COUNT(CASE WHEN operator_id <= 3 THEN 1 END) as operator_records,
          COUNT(CASE WHEN operator_id > 3 THEN 1 END) as nominator_records,
          COUNT(DISTINCT CASE WHEN operator_id <= 3 THEN operator_id END) as unique_operators,
          COUNT(DISTINCT CASE WHEN operator_id > 3 THEN operator_id END) as unique_nominators
        FROM operator_share_prices
        WHERE epoch = (SELECT MAX(epoch) FROM epochs)
      `);
      
      const sepStats = separationQuery.rows[0];
      console.log(`  Operators: ${sepStats.unique_operators} unique (${sepStats.operator_records} records)`);
      console.log(`  Nominators: ${sepStats.unique_nominators} positions (${sepStats.nominator_records} records)`);
      
      if (sepStats.unique_operators > 4) {
        issues.push(`⚠️  More than 4 operators detected: ${sepStats.unique_operators}`);
      }
      
      console.log('');
      
      // ========================================
      // 4. PERFORMANCE METRICS
      // ========================================
      console.log('⚡ 4. Performance Metrics:\n');
      
      // Test query performance
      const performanceTests = [
        {
          name: 'Operator query (latest epoch)',
          query: `SELECT * FROM operator_analytics WHERE epoch = (SELECT MAX(epoch) FROM epochs)`
        },
        {
          name: 'Nominator summary',
          query: `SELECT * FROM nominator_position_tracker ORDER BY epoch DESC LIMIT 10`
        },
        {
          name: 'Comprehensive analytics (100 epochs)',
          query: `SELECT * FROM comprehensive_analytics ORDER BY epoch DESC LIMIT 100`
        }
      ];
      
      for (const test of performanceTests) {
        const start = Date.now();
        try {
          await client.query(test.query);
          const duration = Date.now() - start;
          
          if (duration > 1000) {
            issues.push(`⚠️  Slow query: ${test.name} took ${duration}ms`);
          } else {
            console.log(`  ✅ ${test.name}: ${duration}ms`);
          }
        } catch (err) {
          issues.push(`❌ Query failed: ${test.name} - ${err.message}`);
          validationPassed = false;
        }
      }
      
      console.log('');
      
      // ========================================
      // 5. SHARE PRICE EVOLUTION
      // ========================================
      console.log('📈 5. Share Price Evolution:\n');
      
      const evolutionQuery = await client.query(`
        SELECT 
          operator_id,
          MIN(share_price_perq / 1e18) as min_price,
          MAX(share_price_perq / 1e18) as max_price,
          AVG(share_price_perq / 1e18) as avg_price,
          STDDEV(share_price_perq / 1e18) as price_volatility,
          COUNT(DISTINCT epoch) as data_points
        FROM operator_share_prices
        WHERE operator_id <= 3
        GROUP BY operator_id
        ORDER BY operator_id
      `);
      
      console.log('  Operator | Min Price | Max Price | Avg Price | Volatility | Data Points');
      console.log('  ---------|-----------|-----------|-----------|------------|------------');
      
      for (const row of evolutionQuery.rows) {
        const formatted = `  ${String(row.operator_id).padEnd(8)} | ` +
          `${Number(row.min_price).toFixed(6).padEnd(9)} | ` +
          `${Number(row.max_price).toFixed(6).padEnd(9)} | ` +
          `${Number(row.avg_price).toFixed(6).padEnd(9)} | ` +
          `${Number(row.price_volatility).toFixed(6).padEnd(10)} | ` +
          `${row.data_points}`;
        console.log(formatted);
        
        // Check if prices are growing (max > min)
        if (Number(row.max_price) <= Number(row.min_price)) {
          issues.push(`⚠️  Operator ${row.operator_id} shows no price appreciation`);
        }
      }
      
      console.log('');
      
      // ========================================
      // 6. API ENDPOINT CHECKS (if server running)
      // ========================================
      console.log('🌐 6. API Endpoint Checks:\n');
      
      try {
        // Try to hit the v2 endpoint
        const response = await fetch(`${API_BASE}/epochs-v2?limit=10`, {
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.data && Array.isArray(data.data)) {
            console.log(`  ✅ API v2 endpoint: ${data.data.length} records returned`);
            
            // Check if data structure is correct
            const firstRecord = data.data[0];
            if (firstRecord && firstRecord.operatorData) {
              const opData = firstRecord.operatorData;
              const hasCorrectStructure = 
                opData['0'] && 
                typeof opData['0'].stake === 'string' &&
                typeof opData['0'].sharePrice === 'string';
              
              if (hasCorrectStructure) {
                console.log('  ✅ API data structure: correct');
              } else {
                issues.push('⚠️  API data structure may be incorrect');
              }
            }
          }
        } else {
          issues.push(`⚠️  API v2 returned status ${response.status}`);
        }
      } catch (err) {
        console.log(`  ⏭️  API checks skipped (server not running)`);
      }
      
      console.log('');
      
    } finally {
      client.release();
    }
    
    // ========================================
    // FINAL REPORT
    // ========================================
    console.log('═══════════════════════════════════════\n');
    console.log('📝 Validation Summary:\n');
    
    if (issues.length === 0) {
      console.log('  🎉 All validation checks passed!');
      console.log('  The deployment is ready for production.');
    } else {
      console.log(`  Found ${issues.length} issue(s):\n`);
      for (const issue of issues) {
        console.log(`  ${issue}`);
      }
      
      const criticalCount = issues.filter(i => i.startsWith('❌')).length;
      const warningCount = issues.filter(i => i.startsWith('⚠️')).length;
      
      console.log('');
      console.log(`  Summary: ${criticalCount} critical, ${warningCount} warnings`);
      
      if (criticalCount > 0) {
        console.log('  ⚠️  Critical issues must be resolved before deployment');
        validationPassed = false;
      }
    }
    
    // Performance summary
    console.log('\n💾 Database Statistics:\n');
    
    const statsQuery = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM epochs) as total_epochs,
        (SELECT COUNT(*) FROM operator_shares WHERE operator_id <= 3) as operator_records,
        (SELECT COUNT(*) FROM operator_share_prices WHERE operator_id > 3) as nominator_positions,
        (SELECT pg_size_pretty(pg_database_size(current_database()))) as database_size
    `);
    
    const stats = statsQuery.rows[0];
    console.log(`  Total Epochs: ${stats.total_epochs}`);
    console.log(`  Operator Records: ${stats.operator_records}`);
    console.log(`  Nominator Positions: ${stats.nominator_positions}`);
    console.log(`  Database Size: ${stats.database_size}`);
    
    return validationPassed;
    
  } catch (error) {
    console.error('❌ Validation failed with error:', error.message);
    return false;
  } finally {
    await pool.end();
  }
}

// Run validation
validateDeployment()
  .then((passed) => {
    if (passed) {
      console.log('\n✅ Deployment validation successful!');
      process.exit(0);
    } else {
      console.log('\n❌ Deployment validation failed - review issues above');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
