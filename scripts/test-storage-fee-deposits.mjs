import { activate } from '@autonomys/auto-utils';

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const WS = getArg('ws', 'wss://rpc.mainnet.subspace.foundation/ws');
const DOMAIN_ID = Number(getArg('domain', '0'));

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

async function getTotalStorageFeeDepositsFromOperators(api, domainId) {
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
    console.warn('[getTotalStorageFeeDepositsFromOperators.error]', e?.message || e);
    return 0n;
  }
}

async function main() {
  console.log(`[connect] ${WS}`);
  const api = await activate({ rpcUrl: WS });

  // Test 1: Check current total storage fee deposits from operators
  console.log('\n=== Test 1: Current Total Storage Fee Deposits from Operators ===');
  try {
    const head = await api.rpc.chain.getHeader();
    const headHash = await api.rpc.chain.getBlockHash(head.number.toNumber());
    const atHead = await api.at(headHash);
    
    console.log('[head.block]', head.number.toString());
    console.log('[head.hash]', headHash.toString());
    
    const totalStorageFeeDeposits = await getTotalStorageFeeDepositsFromOperators(atHead, DOMAIN_ID);
    console.log('[totalStorageFeeDeposits]', totalStorageFeeDeposits.toString());
    console.log('[totalStorageFeeDeposits.AI3]', (Number(totalStorageFeeDeposits) / 1e18).toFixed(6));
  } catch (e) {
    console.warn('[current.storageFeeDeposits.error]', e?.message || e);
  }

  // Test 2: Check sample operator entries structure
  console.log('\n=== Test 2: Sample Operator Entries ===');
  try {
    const head = await api.rpc.chain.getHeader();
    const headHash = await api.rpc.chain.getBlockHash(head.number.toNumber());
    const atHead = await api.at(headHash);
    
    const operatorEntries = await atHead.query.domains.operators.entriesPaged({ args: [], pageSize: 3 });
    console.log('[operators.sample.count]', operatorEntries.length);
    
    for (let i = 0; i < operatorEntries.length; i++) {
      const [key, value] = operatorEntries[i];
      const operatorId = key.args[0].toNumber();
      console.log(`[operator.${i}.id]`, operatorId);
      
      if (value && value.isSome) {
        const operator = value.unwrap();
        const storageFeeDeposit = operator.totalStorageFeeDeposit?.toString?.();
        const totalStake = operator.currentTotalStake?.toString?.();
        const totalShares = operator.currentTotalShares?.toString?.();
        
        console.log(`[operator.${i}.storageFeeDeposit]`, storageFeeDeposit || '0');
        console.log(`[operator.${i}.storageFeeDeposit.AI3]`, storageFeeDeposit ? (Number(storageFeeDeposit) / 1e18).toFixed(6) : '0.000000');
        console.log(`[operator.${i}.totalStake]`, totalStake || '0');
        console.log(`[operator.${i}.totalShares]`, totalShares || '0');
      }
    }
  } catch (e) {
    console.warn('[sample.operators.error]', e?.message || e);
  }

  // Test 3: Check historical epochs
  console.log('\n=== Test 3: Historical Epochs ===');
  try {
    const head = await api.rpc.chain.getHeader();
    const headEpoch = await epochAt(api, head.number.toNumber());
    console.log('[current.epoch]', headEpoch);
    
    // Test a few recent epochs
    for (let epoch = Math.max(0, headEpoch - 2); epoch <= headEpoch; epoch++) {
      try {
        const startBlock = await findEpochStartBlock(api, epoch);
        const nextStart = await findEpochStartBlock(api, epoch + 1);
        const endBlock = nextStart - 1;
        const endHash = await api.rpc.chain.getBlockHash(endBlock);
        const atEnd = await api.at(endHash);
        
        console.log(`[epoch.${epoch}.endBlock]`, endBlock);
        
        const totalStorageFeeDeposits = await getTotalStorageFeeDepositsFromOperators(atEnd, DOMAIN_ID);
        console.log(`[epoch.${epoch}.totalStorageFeeDeposits]`, totalStorageFeeDeposits.toString());
        console.log(`[epoch.${epoch}.totalStorageFeeDeposits.AI3]`, (Number(totalStorageFeeDeposits) / 1e18).toFixed(6));
        
      } catch (e) {
        console.warn(`[epoch.${epoch}.error]`, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[historical.epochs.error]', e?.message || e);
  }

  await api.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
