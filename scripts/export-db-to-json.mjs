import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node export-db-to-json.mjs [options]

Options:
  --db <path>          SQLite database path (default: public/data/comprehensive-metrics.db)
  --out <path>         Output JSON file path (default: public/data/comprehensive-metrics-export.json)
  --from <epoch>       Starting epoch number (optional)
  --to <epoch>         Ending epoch number (optional)
  --help, -h           Show this help message

Environment Variables:
  DB_PATH              Database path (overrides --db)
  OUT_PATH             Output path (overrides --out)

Examples:
  # Export all epochs
  node export-db-to-json.mjs

  # Export specific range
  node export-db-to-json.mjs --from 100 --to 200

  # Export to specific file
  node export-db-to-json.mjs --out public/data/my-export.json
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const DB_PATH = getArg('db', 'public/data/comprehensive-metrics.db');
const OUT_PATH = getArg('out', 'public/data/comprehensive-metrics-export.json');
const FROM = getArg('from');
const TO = getArg('to');

async function main() {
  console.log(`[export] Database: ${DB_PATH}`);
  console.log(`[export] Output: ${OUT_PATH}`);
  
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[error] Database file not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  try {
    // Build query
    let query = 'SELECT * FROM epochs';
    const params = [];
    
    if (FROM || TO) {
      query += ' WHERE';
      if (FROM) {
        query += ' epoch >= ?';
        params.push(Number(FROM));
      }
      if (TO) {
        query += FROM ? ' AND' : '';
        query += ' epoch <= ?';
        params.push(Number(TO));
      }
    }
    
    query += ' ORDER BY epoch';
    
    console.log(`[query] ${query} ${params.length > 0 ? `[${params.join(', ')}]` : ''}`);
    
    const rows = await db.all(query, params);
    console.log(`[export] Found ${rows.length} epochs`);
    
    if (rows.length === 0) {
      console.log(`[export] No data to export`);
      return;
    }
    
    // Parse and format data
    const data = rows.map(row => {
      try {
        return JSON.parse(row.data);
      } catch (e) {
        console.warn(`[warn] Failed to parse epoch ${row.epoch}: ${e.message}`);
        return null;
      }
    }).filter(Boolean);
    
    console.log(`[export] Parsed ${data.length} valid epochs`);
    
    // Ensure output directory exists
    const outDir = path.dirname(OUT_PATH);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    
    // Write to file
    fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));
    console.log(`[export] ✅ Exported ${data.length} epochs to ${OUT_PATH}`);
    
    // Show summary
    if (data.length > 0) {
      const firstEpoch = data[0].epoch;
      const lastEpoch = data[data.length - 1].epoch;
      console.log(`[summary] Epochs ${firstEpoch} to ${lastEpoch}`);
      console.log(`[summary] File size: ${(fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2)} MB`);
    }
    
  } finally {
    await db.close();
  }
}

main().catch(e => {
  console.error(`[fatal] ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
