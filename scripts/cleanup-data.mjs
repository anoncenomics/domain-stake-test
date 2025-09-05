#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'public/data';

// Files to keep (whitelist)
const KEEP_FILES = [
  'comprehensive-metrics.db',      // Main database
  'comprehensive-metrics.json',    // Current JSON export
  'epochs.json',                   // Main epochs data
  'epochs-with-storage-fees.json', // Storage fees data
  'storage-fee-deposits.json'      // Storage fee deposits
];

// Files to remove (redundant/backup files)
const REMOVE_FILES = [
  'comprehensive-metrics-original.json',
  'comprehensive-metrics.json.bak',
  'epochs.json.bak',
  'epochs.backup.json',
  'optimized-metrics.json'
];

function cleanupDataDirectory() {
  console.log('🧹 Cleaning up data directory...');
  
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`❌ Data directory ${DATA_DIR} does not exist`);
    return;
  }

  const files = fs.readdirSync(DATA_DIR);
  let removedCount = 0;
  let keptCount = 0;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const stats = fs.statSync(filePath);

    if (stats.isFile()) {
      if (REMOVE_FILES.includes(file)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`🗑️  Removed: ${file}`);
          removedCount++;
        } catch (e) {
          console.error(`❌ Failed to remove ${file}: ${e.message}`);
        }
      } else if (KEEP_FILES.includes(file)) {
        console.log(`✅ Kept: ${file}`);
        keptCount++;
      } else {
        console.log(`⚠️  Unknown file: ${file} (keeping for safety)`);
        keptCount++;
      }
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Removed: ${removedCount} files`);
  console.log(`   Kept: ${keptCount} files`);
  console.log(`   Total: ${files.length} files processed`);
}

function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA_DIR, 'backups', timestamp);
  
  console.log(`\n💾 Creating backup at ${backupDir}...`);
  
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`❌ Data directory ${DATA_DIR} does not exist`);
    return;
  }

  // Create backup directory
  fs.mkdirSync(backupDir, { recursive: true });

  const files = fs.readdirSync(DATA_DIR);
  let backedUpCount = 0;

  for (const file of files) {
    const sourcePath = path.join(DATA_DIR, file);
    const backupPath = path.join(backupDir, file);
    const stats = fs.statSync(sourcePath);

    if (stats.isFile()) {
      try {
        fs.copyFileSync(sourcePath, backupPath);
        console.log(`💾 Backed up: ${file}`);
        backedUpCount++;
      } catch (e) {
        console.error(`❌ Failed to backup ${file}: ${e.message}`);
      }
    }
  }

  console.log(`\n📊 Backup complete: ${backedUpCount} files backed up to ${backupDir}`);
}

function showDirectoryStructure() {
  console.log('\n📁 Current data directory structure:');
  
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`❌ Data directory ${DATA_DIR} does not exist`);
    return;
  }

  const files = fs.readdirSync(DATA_DIR);
  
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const stats = fs.statSync(filePath);
    const size = stats.isFile() ? `(${(stats.size / 1024).toFixed(1)}KB)` : '(dir)';
    
    if (KEEP_FILES.includes(file)) {
      console.log(`  ✅ ${file} ${size}`);
    } else if (REMOVE_FILES.includes(file)) {
      console.log(`  🗑️  ${file} ${size} (will be removed)`);
    } else {
      console.log(`  ⚠️  ${file} ${size} (unknown)`);
    }
  }
}

// Main execution
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node cleanup-data.mjs [options]

Options:
  --backup              Create backup before cleanup
  --dry-run             Show what would be removed without actually removing
  --structure           Show current directory structure
  --help, -h            Show this help message

Examples:
  # Show current structure
  node cleanup-data.mjs --structure

  # Create backup and cleanup
  node cleanup-data.mjs --backup

  # Dry run (see what would be removed)
  node cleanup-data.mjs --dry-run
`);
  process.exit(0);
}

if (argv.includes('--structure')) {
  showDirectoryStructure();
  process.exit(0);
}

if (argv.includes('--backup')) {
  createBackup();
}

if (argv.includes('--dry-run')) {
  console.log('🔍 DRY RUN - No files will be removed');
  showDirectoryStructure();
  console.log('\n📋 Files that would be removed:');
  for (const file of REMOVE_FILES) {
    const filePath = path.join(DATA_DIR, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log(`  🗑️  ${file} (${(stats.size / 1024).toFixed(1)}KB)`);
    }
  }
} else {
  cleanupDataDirectory();
}

console.log('\n✨ Cleanup complete!');
