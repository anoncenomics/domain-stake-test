import fs from 'node:fs';
import path from 'node:path';
import { activate } from '@autonomys/auto-utils';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node backfill-epochs-with-storage-fees.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --from <epoch>       Starting epoch number (default: 0)
  --to <epoch>         Ending epoch number or 'current' (default: current)
  --out <path>         Output file path (default: public/data/epochs-with-storage-fees.json)
  --append             Append to existing output file instead of overwriting
  --help, -h           Show this help message

Environment Variables:
  RPC_URL_WS           WebSocket RPC endpoint (overrides --ws)
  RPC_USER             RPC username (overrides --user)
  RPC_PASS             RPC password (overrides --pass)
  DOMAIN               Domain ID (overrides --domain)
  FROM                 Starting epoch (overrides --from)
  TO                   Ending epoch (overrides --to)
  OUT                  Output file path (overrides --out)

Examples:
  # Use authenticated Autonomys node (default)
  node backfill-epochs-with-storage-fees.mjs --user your_username --pass your_password --domain 0

  # Use environment variables (recommended)
  export RPC_USER=your_username
  export RPC_PASS=your_password
  node backfill-epochs-with-storage-fees.mjs --domain 0

  # Use .env file
  export $(cat .env | xargs)
  node backfill-epochs-with-storage-fees.mjs --domain 0

  # Use different node
  node backfill-epochs-with-storage-fees.mjs --ws wss://other-node:9944 --domain 0
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i+1] && !argv[i+1].startsWith('--')) return argv[i+1];
  return process.env[k.toUpperCase()] ?? d;
};

// Default to authenticated Autonomys RPC endpoint
const WS = getArg('ws', 'wss://rpc.anoncenomics.com');
const RPC_USER = getArg('user', process.env.RPC_USER || '');
const RPC_PASS = getArg('pass', process.env.RPC_PASS || '');
const DOMAIN_ID = Number(getArg('domain', '0'));
const FROM = getArg('from');
const TO = getArg('to', 'current');
const APPEND = argv.includes('--append');
const OUT = getArg('out', 'public/data/epochs-with-storage-fees.json');

// Validate authentication if using the default Autonomys endpoint
if (WS.includes('rpc.anoncenomics.com') && (!RPC_USER || !RPC_PASS)) {
  console.error('❌ Error: Authentication required for Autonomys RPC endpoint');
  console.error('Please provide credentials using one of these methods:');
  console.error('');
  console.error('1. Command line arguments:');
  console.error('   --user your_username --pass your_password');
  console.error('');
  console.error('2. Environment variables:');
  console.error('   export RPC_USER=your_username');
  console.error('   export RPC_PASS=your_password');
  console.error('');
  console.error('3. .env file:');
  console.error('   cp .env.example .env');
  console.error('   # Edit .env with your credentials');
  console.error('   export $(cat .env | xargs)');
  console.error('');
  console.error('4. Use a different node:');
  console.error('   --ws wss://other-node:9944');
  process.exit(1);
}

function ensureDir(p){ fs.mkdirSync(path.dirname(p), { recursive: true }); }
function mapToObj(m){
  if (!m) return {};
  const out = {};
  try {
    if (typeof m.entries === 'function'){
      for (const [k, v] of m.entries()){
        const kk = (k?.toNumber?.() ?? Number(k));
        out[kk] = v?.toString?.() ?? String(v);
      }
      return out;
    }
    const j = m.toJSON?.() ?? m;
    if (j && typeof j === 'object'){
      for (const [k, v] of Object.entries(j)){
        if (v && typeof v === 'object' && typeof v.toString === 'function'){
          out[k] = v.toString();
        } else if (typeof v === 'string' && v.startsWith('0x')){
          // hex -> decimal string
          out[k] = BigInt(v).toString();
        } else {
          out[k] = String(v);
        }
      }
      return out;
    }
  } catch {}
  return out;
}

async function readSummaryAt(api, blockNumber){
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const at = await api.at(hash);
  const opt = await at.query.domains.domainStakingSummary(DOMAIN_ID);
  if (!opt || opt.isNone) return null;
  const s = opt.unwrap();
  const epoch = s.currentEpochIndex ?? s.epochIndex ?? s.epoch;
  return {
    blockNumber,
    hash: hash.toString(),
    epoch: typeof epoch?.toNumber === 'function' ? epoch.toNumber() : Number(epoch),
    totalStake: (s.currentTotalStake ?? s.totalStake)?.toString?.() ?? null,
    operatorStakes: mapToObj(s.currentOperators),
    rewards: mapToObj(s.currentEpochRewards)
  };
}

async function epochAt(api, blockNumber){
  const sum = await readSummaryAt(api, blockNumber);
  return sum?.epoch ?? null;
}

async function findEpochStartBlock(api, targetEpoch){
  const head = await api.rpc.chain.getHeader();
  let lo = 1, hi = head.number.toNumber(), ans = null;
  const cur = await epochAt(api, hi);
  if (cur == null) throw new Error('Cannot read epoch at head');
  if (targetEpoch > cur) throw new Error(`target epoch ${targetEpoch} > current ${cur}`);
  while (lo < hi){
    const mid = Math.floor((lo + hi)/2);
    const e = await epochAt(api, mid);
    if (e == null){ lo = mid + 1; continue; }
    if (e >= targetEpoch){ ans = mid; hi = mid; } else { lo = mid + 1; }
  }
  const eLo = await epochAt(api, lo);
  if (eLo !== targetEpoch) throw new Error(`Failed to locate start: epoch@${lo}=${eLo}`);
  return lo;
}

async function getTotalStorageFeeDeposits(api, domainId) {
  try {
    const entries = await api.query.domains.operators.entries();
    const operatorIds = entries.map(([k]) => k.args[0].toNumber());
    let totalStorageFeeDeposits = 0n;
    
    for (const opId of operatorIds) {
      try {
        const oper = await api.query.domains.operators(opId);
        if (oper && oper.isSome) {
          const v = oper.unwrap();
          const storageFeeDeposit = v.totalStorageFeeDeposit?.toString?.();
          if (storageFeeDeposit) {
            totalStorageFeeDeposits += BigInt(storageFeeDeposit);
          }
        }
      } catch (e) {
        console.warn(`[operator.${opId}.error]`, e?.message || e);
      }
    }
    
    return totalStorageFeeDeposits;
  } catch (e) {
    console.warn('[getTotalStorageFeeDeposits.error]', e?.message || e);
    return 0n;
  }
}

async function main(){
  console.log(`[connect] ${WS}`);
  const api = await activate({ rpcUrl: WS, rpcUser: RPC_USER, rpcPass: RPC_PASS });
  console.log(`[config] domain=${DOMAIN_ID}`);

  // Test connection and get node info
  try {
    const head = await api.rpc.chain.getHeader();
    console.log(`[connected] block #${head.number.toNumber()} • hash: ${head.hash.toString()}`);
    
    // Get chain name and version if available
    try {
      const [chain, version] = await Promise.all([
        api.rpc.system.chain(),
        api.rpc.system.version()
      ]);
      console.log(`[node] ${chain.toString()} v${version.toString()}`);
    } catch (e) {
      console.log(`[node] connected successfully`);
    }
  } catch (e) {
    console.error(`[error] Failed to connect to node at ${WS}`);
    console.error(`[error] Make sure your node is running and accessible`);
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }

  const head = await api.rpc.chain.getHeader();
  const headEpoch = await epochAt(api, head.number.toNumber());
  if (headEpoch == null) throw new Error('Cannot read current epoch');

  const startEpoch = FROM === 'current' ? headEpoch : Number(FROM ?? 0);
  const endEpoch   = TO === 'current' ? headEpoch : Number(TO);

  console.log(`[range] epochs ${startEpoch}…${endEpoch}`);

  let existing = [];
  if (APPEND && fs.existsSync(OUT)){
    existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  }

  const rows = [...existing];
  let lastWrittenLength = rows.length;

  for (let ep = startEpoch; ep <= endEpoch; ep++){
    console.log(`[epoch] ${ep}`);
    const startBlock = await findEpochStartBlock(api, ep);
    let endBlock;
    let hasConfirmedEnd = true;
    try {
      const nextStart = await findEpochStartBlock(api, ep + 1);
      endBlock = nextStart - 1;
    } catch {
      // If the next epoch start is not yet discoverable, this epoch is still in progress.
      // Skip writing a provisional row to avoid incomplete rewards being persisted.
      hasConfirmedEnd = false;
      console.log(`[skip] epoch ${ep} has no confirmed end block yet; will retry on next run`);
    }

    if (!hasConfirmedEnd){
      // Do not persist incomplete epoch rows
      if (rows.length > lastWrittenLength){
        ensureDir(OUT);
        fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
        console.log(`[write] ${OUT} • count=${rows.length}`);
        lastWrittenLength = rows.length;
      }
      continue;
    }

    const startSnap = await readSummaryAt(api, startBlock);
    const endSnap   = await readSummaryAt(api, endBlock);

    // Derive operator share prices at epoch end
    const operatorSharePrices = {};
    try {
      const atEnd = await api.at(await api.rpc.chain.getBlockHash(endBlock));
      const entries = await atEnd.query.domains.operators.entries();
      const operatorIds = entries.map(([k]) => k.args[0].toNumber());
      for (const opId of operatorIds){
        try {
          const opt = await atEnd.query.domains.operatorEpochSharePrice(DOMAIN_ID, [opId, ep]);
          if (opt && opt.isSome !== undefined){
            if (opt.isSome){ operatorSharePrices[String(opId)] = opt.unwrap().toString(); continue; }
          } else if (opt) {
            operatorSharePrices[String(opId)] = opt.toString();
            continue;
          }
          const oper = await atEnd.query.domains.operators(opId);
          if (oper && oper.isSome){
            const v = oper.unwrap();
            const stake = v.currentTotalStake?.toString?.();
            const shares = v.currentTotalShares?.toString?.();
            if (stake && shares && shares !== '0'){
              const p = (BigInt(stake) * 10n**18n) / BigInt(shares);
              operatorSharePrices[String(opId)] = p.toString();
            }
          }
        } catch (e) {
          console.warn(`[sharePrice op=${opId} ep=${ep}]`, e?.message || e);
        }
      }
    } catch (e) {
      console.warn(`[sharePrice epoch=${ep}]`, e?.message || e);
    }

    // Get total storage fee deposits at epoch end
    let totalStorageFeeDeposits = 0n;
    try {
      const atEnd = await api.at(await api.rpc.chain.getBlockHash(endBlock));
      totalStorageFeeDeposits = await getTotalStorageFeeDeposits(atEnd, DOMAIN_ID);
      console.log(`[epoch.${ep}.totalStorageFeeDeposits]`, totalStorageFeeDeposits.toString());
      console.log(`[epoch.${ep}.totalStorageFeeDeposits.AI3]`, (Number(totalStorageFeeDeposits) / 1e18).toFixed(6));
    } catch (e) {
      console.warn(`[storageFeeDeposits.epoch=${ep}]`, e?.message || e);
    }

    rows.push({
      domainId: DOMAIN_ID,
      epoch: ep,
      startBlock,
      startHash: startSnap?.hash,
      endBlock,
      endHash: endSnap?.hash,
      totalStake: startSnap?.totalStake,
      operatorStakes: startSnap?.operatorStakes,
      rewards: endSnap?.rewards,
      totalStorageFeeDeposits: totalStorageFeeDeposits.toString(),
      ...(Object.keys(operatorSharePrices).length ? { operatorSharePrices } : {})
    });

    // Persist after each completed epoch to avoid losing progress
    ensureDir(OUT);
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
    console.log(`[write] ${OUT} • count=${rows.length}`);
    lastWrittenLength = rows.length;
  }

  if (rows.length > lastWrittenLength){
    ensureDir(OUT);
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
    console.log(`[write] ${OUT} • count=${rows.length}`);
  }

  await api.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
