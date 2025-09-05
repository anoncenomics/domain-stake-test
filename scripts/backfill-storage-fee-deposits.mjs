import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const WS = getArg('ws', 'wss://rpc.mainnet.subspace.foundation/ws');
const DOMAIN_ID = Number(getArg('domain', '0'));
const FROM = getArg('from', '0');
const TO = getArg('to', 'current');
const APPEND = argv.includes('--append');
const OUT = getArg('out', 'public/data/storage-fee-deposits.json');

function ensureDir(p){ fs.mkdirSync(path.dirname(p), { recursive: true }); }

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

async function main() {
  console.log(`[connect] ${WS}`);
  const api = await activate({ rpcUrl: WS });
  console.log(`[config] domain=${DOMAIN_ID}`);

  const head = await api.rpc.chain.getHeader();
  const headEpoch = await epochAt(api, head.number.toNumber());
  if (headEpoch == null) throw new Error('Cannot read current epoch');

  const startEpoch = FROM === 'current' ? headEpoch : Number(FROM ?? 0);
  const endEpoch   = TO === 'current' ? headEpoch : Number(TO);

  console.log(`[range] epochs ${startEpoch}…${endEpoch}`);

  let existing = [];
  if (APPEND && fs.existsSync(OUT)) {
    existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  }

  const rows = [...existing];
  let lastWrittenLength = rows.length;

  for (let ep = startEpoch; ep <= endEpoch; ep++) {
    console.log(`[epoch] ${ep}`);
    const startBlock = await findEpochStartBlock(api, ep);
    let endBlock;
    let hasConfirmedEnd = true;
    try {
      const nextStart = await findEpochStartBlock(api, ep + 1);
      endBlock = nextStart - 1;
    } catch {
      // If the next epoch start is not yet discoverable, this epoch is still in progress.
      // Skip writing a provisional row to avoid incomplete data being persisted.
      hasConfirmedEnd = false;
      console.log(`[skip] epoch ${ep} has no confirmed end block yet; will retry on next run`);
    }

    if (!hasConfirmedEnd) {
      // Do not persist incomplete epoch rows
      if (rows.length > lastWrittenLength) {
        ensureDir(OUT);
        fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
        console.log(`[write] ${OUT} • count=${rows.length}`);
        lastWrittenLength = rows.length;
      }
      continue;
    }

    const endHash = await api.rpc.chain.getBlockHash(endBlock);
    const atEnd = await api.at(endHash);

    // Get total storage fee deposits at epoch end
    let totalStorageFeeDeposits = 0n;
    try {
      totalStorageFeeDeposits = await getTotalStorageFeeDeposits(atEnd, DOMAIN_ID);
      console.log(`[epoch.${ep}.totalStorageFeeDeposits]`, totalStorageFeeDeposits.toString());
      console.log(`[epoch.${ep}.totalStorageFeeDeposits.AI3]`, (Number(totalStorageFeeDeposits) / 1e18).toFixed(6));
    } catch (e) {
      console.warn(`[storageFeeDeposits.epoch=${ep}]`, e?.message || e);
    }

    rows.push({
      domainId: DOMAIN_ID,
      epoch: ep,
      endBlock,
      endHash: endHash.toString(),
      totalStorageFeeDeposits: totalStorageFeeDeposits.toString()
    });

    // Persist after each completed epoch to avoid losing progress
    ensureDir(OUT);
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
    console.log(`[write] ${OUT} • count=${rows.length}`);
    lastWrittenLength = rows.length;
  }

  if (rows.length > lastWrittenLength) {
    ensureDir(OUT);
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
    console.log(`[write] ${OUT} • count=${rows.length}`);
  }

  await api.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
