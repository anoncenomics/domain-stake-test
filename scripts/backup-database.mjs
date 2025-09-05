#!/usr/bin/env node

/**
 * Database Backup Script
 * Creates a timestamped backup of the current Supabase database state
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const { Pool } = pg;

// Database configuration from environment
const PG_HOST = process.env.PG_HOST || 'aws-1-us-east-1.pooler.supabase.com';
const PG_PORT = parseInt(process.env.PG_PORT || '6543');
const PG_NAME = process.env.PG_NAME || 'postgres';
const PG_USER = process.env.PG_USER || 'postgres.kaxlpwjlesmlfiawsfvy';
const PG_PASS = process.env.PG_PASS || process.env.PG_PASSWORD || 'dl33D#YWGmrm0EKD%Lk7t$';

async function backupDatabase() {
  console.log('🔄 Starting database backup...');
  
  const pool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: PG_NAME,
    user: PG_USER,
    password: PG_PASS,
    max: 10
  });

  try {
    // Create backup directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '..', 'backups', timestamp);
    await fs.mkdir(backupDir, { recursive: true });
    
    console.log(`📁 Backup directory: ${backupDir}`);

    // Export epochs table structure and data count
    const client = await pool.connect();
    try {
      // Get table statistics
      const stats = await client.query(`
        SELECT 
          'epochs' as table_name,
          COUNT(*) as row_count,
          pg_size_pretty(pg_total_relation_size('epochs')) as size
        FROM epochs
        UNION ALL
        SELECT 
          'comprehensive_analytics' as table_name,
          COUNT(*) as row_count,
          pg_size_pretty(pg_total_relation_size('comprehensive_analytics')) as size
        FROM comprehensive_analytics
      `);
      
      await fs.writeFile(
        path.join(backupDir, 'table_stats.json'),
        JSON.stringify(stats.rows, null, 2)
      );
      console.log('📊 Table statistics saved');

      // Get schema information
      const schemaQuery = await client.query(`
        SELECT 
          table_name,
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' 
        AND table_name IN ('epochs', 'comprehensive_analytics')
        ORDER BY table_name, ordinal_position
      `);
      
      await fs.writeFile(
        path.join(backupDir, 'schema.json'),
        JSON.stringify(schemaQuery.rows, null, 2)
      );
      console.log('📋 Schema information saved');

      // Export sample data (first and last 100 epochs)
      const sampleData = await client.query(`
        (SELECT epoch, end_block, timestamp FROM epochs ORDER BY epoch ASC LIMIT 100)
        UNION ALL
        (SELECT epoch, end_block, timestamp FROM epochs ORDER BY epoch DESC LIMIT 100)
        ORDER BY epoch
      `);
      
      await fs.writeFile(
        path.join(backupDir, 'sample_epochs.json'),
        JSON.stringify(sampleData.rows, null, 2)
      );
      console.log('📝 Sample data saved');

      // Get list of all functions
      const functionsQuery = await client.query(`
        SELECT 
          routine_name,
          routine_type,
          data_type
        FROM information_schema.routines
        WHERE routine_schema = 'public'
        AND routine_type = 'FUNCTION'
      `);
      
      await fs.writeFile(
        path.join(backupDir, 'functions.json'),
        JSON.stringify(functionsQuery.rows, null, 2)
      );
      console.log('🔧 Function list saved');

      // Create backup metadata
      const metadata = {
        timestamp: new Date().toISOString(),
        database: {
          host: PG_HOST,
          port: PG_PORT,
          database: PG_NAME,
          user: PG_USER
        },
        tables: stats.rows,
        backup_type: 'metadata_and_samples',
        note: 'Pre-migration backup for operator share price normalization'
      };
      
      await fs.writeFile(
        path.join(backupDir, 'backup_metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      console.log('✅ Backup completed successfully!');
      console.log(`📁 Backup location: ${backupDir}`);
      
      // Return backup location for use in other scripts
      return backupDir;
      
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Backup failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  backupDatabase()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { backupDatabase };
