#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node setup-postgres.mjs [options]

Options:
  --db-name <name>     Database name (default: domainstake)
  --db-user <user>     Database username (default: domainstake_user)
  --db-pass <pass>     Database password (default: auto-generated)
  --db-host <host>     Database host (default: localhost)
  --db-port <port>     Database port (default: 5432)
  --skip-install       Skip PostgreSQL installation (assumes already installed)
  --skip-db-create     Skip database creation (assumes database exists)
  --dry-run            Show what would be done without executing
  --help, -h           Show this help message

Environment Variables:
  DB_NAME              Database name (overrides --db-name)
  DB_USER              Database username (overrides --db-user)
  DB_PASS              Database password (overrides --db-pass)
  DB_HOST              Database host (overrides --db-host)
  DB_PORT              Database port (overrides --db-port)

Examples:
  # Full setup with auto-generated password
  node setup-postgres.mjs

  # Custom database name and user
  node setup-postgres.mjs --db-name mydomain --db-user myuser

  # Dry run to see what would be done
  node setup-postgres.mjs --dry-run

  # Skip installation, just create database
  node setup-postgres.mjs --skip-install
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const DB_NAME = getArg('db-name', 'domainstake');
const DB_USER = getArg('db-user', 'domainstake_user');
const DB_PASS = getArg('db-pass', generatePassword());
const DB_HOST = getArg('db-host', 'localhost');
const DB_PORT = getArg('db-port', '5432');
const SKIP_INSTALL = argv.includes('--skip-install');
const SKIP_DB_CREATE = argv.includes('--skip-db-create');
const DRY_RUN = argv.includes('--dry-run');

function generatePassword() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function detectOS() {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

function checkCommand(command) {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installPostgreSQL() {
  const os = detectOS();
  console.log(`[install] Detected OS: ${os}`);

  if (os === 'macos') {
    if (checkCommand('brew --version')) {
      console.log(`[install] Installing PostgreSQL via Homebrew...`);
      if (!DRY_RUN) {
        execSync('brew install postgresql', { stdio: 'inherit' });
        execSync('brew services start postgresql', { stdio: 'inherit' });
      }
    } else {
      console.error(`[error] Homebrew not found. Please install Homebrew first:`);
      console.error(`  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`);
      process.exit(1);
    }
  } else if (os === 'linux') {
    if (checkCommand('apt --version')) {
      console.log(`[install] Installing PostgreSQL via apt...`);
      if (!DRY_RUN) {
        execSync('sudo apt update', { stdio: 'inherit' });
        execSync('sudo apt install -y postgresql postgresql-contrib', { stdio: 'inherit' });
        execSync('sudo systemctl start postgresql', { stdio: 'inherit' });
        execSync('sudo systemctl enable postgresql', { stdio: 'inherit' });
      }
    } else if (checkCommand('yum --version')) {
      console.log(`[install] Installing PostgreSQL via yum...`);
      if (!DRY_RUN) {
        execSync('sudo yum install -y postgresql postgresql-server postgresql-contrib', { stdio: 'inherit' });
        execSync('sudo postgresql-setup initdb', { stdio: 'inherit' });
        execSync('sudo systemctl start postgresql', { stdio: 'inherit' });
        execSync('sudo systemctl enable postgresql', { stdio: 'inherit' });
      }
    } else {
      console.error(`[error] Unsupported package manager. Please install PostgreSQL manually.`);
      process.exit(1);
    }
  } else if (os === 'windows') {
    console.log(`[install] Please install PostgreSQL manually from:`);
    console.log(`  https://www.postgresql.org/download/windows/`);
    console.log(`[install] After installation, run this script with --skip-install`);
    process.exit(1);
  } else {
    console.error(`[error] Unsupported operating system: ${os}`);
    process.exit(1);
  }
}

function createDatabase() {
  console.log(`[database] Creating database: ${DB_NAME}`);
  console.log(`[database] Creating user: ${DB_USER}`);
  console.log(`[database] Password: ${DB_PASS}`);

  const sql = `
-- Create database
CREATE DATABASE ${DB_NAME};

-- Create user
CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};

-- Connect to the database
\\c ${DB_NAME}

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
`;

  if (!DRY_RUN) {
    try {
      // Write SQL to temporary file
      const sqlFile = path.join(process.cwd(), 'temp_setup.sql');
      fs.writeFileSync(sqlFile, sql);

      // Try different approaches for macOS vs Linux
      const os = detectOS();
      let success = false;

      if (os === 'macos') {
        // On macOS with Homebrew, try using current user as superuser
        try {
          console.log(`[database] Trying macOS Homebrew approach...`);
          execSync(`psql -f ${sqlFile}`, { stdio: 'inherit' });
          success = true;
        } catch (error) {
          console.log(`[database] Homebrew approach failed, trying alternative...`);
          try {
            // Try with createdb and createuser commands
            execSync(`createdb ${DB_NAME}`, { stdio: 'inherit' });
            execSync(`createuser --interactive --pwprompt ${DB_USER}`, { 
              stdio: 'inherit',
              input: `${DB_PASS}\n${DB_PASS}\n` // Answer password prompts
            });
            
            // Grant privileges
            const grantSql = `
              GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
              \\c ${DB_NAME}
              GRANT ALL ON SCHEMA public TO ${DB_USER};
              GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
              GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
              ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
              ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
            `;
            const grantFile = path.join(process.cwd(), 'temp_grant.sql');
            fs.writeFileSync(grantFile, grantSql);
            execSync(`psql -d ${DB_NAME} -f ${grantFile}`, { stdio: 'inherit' });
            fs.unlinkSync(grantFile);
            success = true;
          } catch (altError) {
            console.log(`[database] Alternative approach also failed`);
          }
        }
      } else {
        // On Linux, try the traditional postgres user approach
        try {
          execSync(`sudo -u postgres psql -f ${sqlFile}`, { stdio: 'inherit' });
          success = true;
        } catch (error) {
          console.log(`[database] Traditional approach failed`);
        }
      }

      if (!success) {
        throw new Error('All database creation approaches failed');
      }

      // Clean up
      fs.unlinkSync(sqlFile);
    } catch (error) {
      console.error(`[error] Failed to create database: ${error.message}`);
      console.log(`[manual] Please run these commands manually:`);
      console.log(`  psql`);
      console.log(`  ${sql}`);
      console.log(`\n[manual] Or use these individual commands:`);
      console.log(`  createdb ${DB_NAME}`);
      console.log(`  createuser --interactive --pwprompt ${DB_USER}`);
      console.log(`  psql -d ${DB_NAME} -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"`);
      console.log(`  psql -d ${DB_NAME} -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"`);
      process.exit(1);
    }
  }
}

function testConnection() {
  console.log(`[test] Testing database connection...`);
  
  if (!DRY_RUN) {
    try {
      const testScript = `
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: '${DB_HOST}',
  port: ${DB_PORT},
  database: '${DB_NAME}',
  user: '${DB_USER}',
  password: '${DB_PASS}',
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

async function test() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT version()');
    console.log('✅ Connection successful');
    console.log('PostgreSQL version:', result.rows[0].version.split(' ')[0]);
    client.release();
    await pool.end();
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  }
}

test();
`;
      
      const testFile = path.join(process.cwd(), 'temp_test.mjs');
      fs.writeFileSync(testFile, testScript);
      
      execSync(`node ${testFile}`, { stdio: 'inherit' });
      
      fs.unlinkSync(testFile);
    } catch (error) {
      console.error(`[error] Connection test failed: ${error.message}`);
      process.exit(1);
    }
  }
}

function createEnvFile() {
  const envContent = `# PostgreSQL Configuration
PG_HOST=${DB_HOST}
PG_PORT=${DB_PORT}
PG_NAME=${DB_NAME}
PG_USER=${DB_USER}
PG_PASS=${DB_PASS}

# Optional: Override RPC settings
# RPC_URL_WS=wss://rpc.anoncenomics.com/ws
# RPC_USER=your_username
# RPC_PASS=your_password
`;

  const envFile = path.join(process.cwd(), '.env.postgres');
  
  if (!DRY_RUN) {
    fs.writeFileSync(envFile, envContent);
    console.log(`[env] Created environment file: ${envFile}`);
  } else {
    console.log(`[env] Would create environment file: ${envFile}`);
  }
}

function showNextSteps() {
  console.log(`\n[setup] ✅ PostgreSQL setup complete!`);
  console.log(`\n[next] Next steps:`);
  console.log(`  1. Source the environment file:`);
  console.log(`     source .env.postgres`);
  console.log(`\n  2. Test the migration script:`);
  console.log(`     node scripts/migrate-sqlite-to-postgres.mjs --dry-run`);
  console.log(`\n  3. Migrate your existing data:`);
  console.log(`     node scripts/migrate-sqlite-to-postgres.mjs --validate`);
  console.log(`\n  4. Start using PostgreSQL backfill:`);
  console.log(`     node scripts/backfill-comprehensive-metrics-postgres.mjs --domain 0`);
  console.log(`\n[info] Database credentials:`);
  console.log(`  Host: ${DB_HOST}:${DB_PORT}`);
  console.log(`  Database: ${DB_NAME}`);
  console.log(`  User: ${DB_USER}`);
  console.log(`  Password: ${DB_PASS}`);
}

async function main() {
  console.log(`[setup] PostgreSQL Setup for DomainStake`);
  console.log(`[config] Database: ${DB_NAME}`);
  console.log(`[config] User: ${DB_USER}`);
  console.log(`[config] Host: ${DB_HOST}:${DB_PORT}`);

  if (DRY_RUN) {
    console.log(`[dry-run] This is a dry run - no changes will be made`);
  }

  try {
    // Step 1: Install PostgreSQL
    if (!SKIP_INSTALL) {
      console.log(`\n[step 1] Installing PostgreSQL...`);
      installPostgreSQL();
    } else {
      console.log(`\n[step 1] Skipping PostgreSQL installation`);
    }

    // Step 2: Create database
    if (!SKIP_DB_CREATE) {
      console.log(`\n[step 2] Creating database and user...`);
      createDatabase();
    } else {
      console.log(`\n[step 2] Skipping database creation`);
    }

    // Step 3: Test connection
    console.log(`\n[step 3] Testing connection...`);
    testConnection();

    // Step 4: Create environment file
    console.log(`\n[step 4] Creating environment file...`);
    createEnvFile();

    // Step 5: Show next steps
    showNextSteps();

  } catch (error) {
    console.error(`[error] Setup failed: ${error.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
