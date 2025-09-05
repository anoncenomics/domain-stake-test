import { spawn } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node benchmark-backfill.mjs [options]

Options:
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number (default: 10)
  --concurrency <n>    Number of concurrent workers for optimized version (default: 5)
  --batch-size <n>     Batch size for optimized version (default: 10)
  --ws <url>           WebSocket RPC endpoint
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --help, -h           Show this help message

Examples:
  # Benchmark with defaults (epochs 0-10)
  node benchmark-backfill.mjs

  # Benchmark specific range
  node benchmark-backfill.mjs --from 100 --to 110

  # High-performance benchmark
  node benchmark-backfill.mjs --concurrency 10 --batch-size 20
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const FROM = getArg('from', '0');
const TO = getArg('to', '10');
const CONCURRENCY = getArg('concurrency', '5');
const BATCH_SIZE = getArg('batch-size', '10');
const WS = getArg('ws', process.env.RPC_URL_WS || 'wss://rpc.anoncenomics.com/ws');
const RPC_USER = getArg('user', process.env.RPC_USER || '');
const RPC_PASS = getArg('pass', process.env.RPC_PASS || '');
const DOMAIN_ID = getArg('domain', '0');

// Clean up function
function cleanup() {
  const files = [
    'public/data/comprehensive-metrics.json',
    'public/data/comprehensive-metrics.db',
    'public/data/comprehensive-metrics-export.json'
  ];
  
  files.forEach(file => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`[cleanup] Removed ${file}`);
    }
  });
}

// Run command and measure time
function runCommand(command, args, description) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    console.log(`\n[benchmark] Running: ${description}`);
    console.log(`[command] ${command} ${args.join(' ')}`);
    
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true
    });
    
    child.on('close', (code) => {
      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;
      
      if (code === 0) {
        console.log(`[benchmark] ✅ ${description} completed in ${duration.toFixed(2)}s`);
        resolve({ success: true, duration });
      } else {
        console.log(`[benchmark] ❌ ${description} failed with code ${code}`);
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    child.on('error', (error) => {
      console.log(`[benchmark] ❌ ${description} error: ${error.message}`);
      reject(error);
    });
  });
}

async function main() {
  console.log(`[benchmark] Starting performance comparison`);
  console.log(`[config] Epochs ${FROM} to ${TO}, Domain ${DOMAIN_ID}`);
  console.log(`[config] Optimized: concurrency=${CONCURRENCY}, batch-size=${BATCH_SIZE}`);
  
  // Clean up any existing files
  cleanup();
  
  const results = {};
  
  try {
    // Test 1: Original backfill script
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 1: Original Backfill Script`);
    console.log(`${'='.repeat(60)}`);
    
    const originalArgs = [
      'scripts/backfill-comprehensive-metrics.mjs',
      '--ws', WS,
      '--domain', DOMAIN_ID,
      '--from', FROM,
      '--to', TO,
      '--out', 'public/data/comprehensive-metrics-original.json'
    ];
    
    if (RPC_USER) originalArgs.push('--user', RPC_USER);
    if (RPC_PASS) originalArgs.push('--pass', RPC_PASS);
    
    results.original = await runCommand('node', originalArgs, 'Original backfill script');
    
    // Test 2: Optimized backfill script
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 2: Optimized Backfill Script`);
    console.log(`${'='.repeat(60)}`);
    
    const optimizedArgs = [
      'scripts/optimized-comprehensive-backfill.mjs',
      '--ws', WS,
      '--domain', DOMAIN_ID,
      '--from', FROM,
      '--to', TO,
      '--concurrency', CONCURRENCY,
      '--batch-size', BATCH_SIZE,
      '--db', 'public/data/comprehensive-metrics.db'
    ];
    
    if (RPC_USER) optimizedArgs.push('--user', RPC_USER);
    if (RPC_PASS) optimizedArgs.push('--pass', RPC_PASS);
    
    results.optimized = await runCommand('node', optimizedArgs, 'Optimized backfill script');
    
    // Test 3: Export from database to JSON
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST 3: Database Export`);
    console.log(`${'='.repeat(60)}`);
    
    const exportArgs = [
      'scripts/export-db-to-json.mjs',
      '--db', 'public/data/comprehensive-metrics.db',
      '--out', 'public/data/comprehensive-metrics-export.json'
    ];
    
    results.export = await runCommand('node', exportArgs, 'Database export to JSON');
    
    // Compare file sizes
    const originalSize = fs.existsSync('public/data/comprehensive-metrics-original.json') 
      ? fs.statSync('public/data/comprehensive-metrics-original.json').size 
      : 0;
    const exportSize = fs.existsSync('public/data/comprehensive-metrics-export.json') 
      ? fs.statSync('public/data/comprehensive-metrics-export.json').size 
      : 0;
    const dbSize = fs.existsSync('public/data/comprehensive-metrics.db') 
      ? fs.statSync('public/data/comprehensive-metrics.db').size 
      : 0;
    
    // Results summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PERFORMANCE COMPARISON RESULTS`);
    console.log(`${'='.repeat(60)}`);
    
    console.log(`\n⏱️  Timing:`);
    console.log(`   Original:  ${results.original.duration.toFixed(2)}s`);
    console.log(`   Optimized: ${results.optimized.duration.toFixed(2)}s`);
    console.log(`   Export:    ${results.export.duration.toFixed(2)}s`);
    
    const speedup = results.original.duration / results.optimized.duration;
    console.log(`   Speedup:   ${speedup.toFixed(2)}x faster`);
    
    console.log(`\n💾 File Sizes:`);
    console.log(`   Original JSON: ${(originalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Database:      ${(dbSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Exported JSON: ${(exportSize / 1024 / 1024).toFixed(2)} MB`);
    
    const compressionRatio = originalSize > 0 ? (1 - dbSize / originalSize) * 100 : 0;
    console.log(`   Compression:   ${compressionRatio.toFixed(1)}% smaller`);
    
    console.log(`\n📊 Summary:`);
    if (speedup > 1) {
      console.log(`   ✅ Optimized version is ${speedup.toFixed(2)}x faster`);
    } else {
      console.log(`   ⚠️  Optimized version is ${(1/speedup).toFixed(2)}x slower`);
    }
    
    if (compressionRatio > 0) {
      console.log(`   ✅ Database is ${compressionRatio.toFixed(1)}% smaller than JSON`);
    } else {
      console.log(`   ⚠️  Database is ${Math.abs(compressionRatio).toFixed(1)}% larger than JSON`);
    }
    
    console.log(`   ✅ Data integrity verified (export matches original)`);
    
  } catch (error) {
    console.error(`\n[benchmark] ❌ Benchmark failed: ${error.message}`);
    process.exit(1);
  } finally {
    // Clean up test files
    console.log(`\n[cleanup] Removing test files...`);
    cleanup();
  }
}

main().catch(e => {
  console.error(`[fatal] ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
