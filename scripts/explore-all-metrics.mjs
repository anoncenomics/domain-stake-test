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

async function testStorageItem(api, name, queryFn, description = '') {
  try {
    const result = await queryFn();
    console.log(`[${name}] ✅ ${description}`);
    if (result !== null && result !== undefined) {
      if (typeof result === 'object' && result.isSome !== undefined) {
        console.log(`  - isSome: ${result.isSome}`);
        if (result.isSome) {
          const unwrapped = result.unwrap();
          console.log(`  - value: ${unwrapped?.toString?.() || JSON.stringify(unwrapped)}`);
        }
      } else {
        console.log(`  - value: ${result?.toString?.() || JSON.stringify(result)}`);
      }
    }
    return true;
  } catch (e) {
    console.log(`[${name}] ❌ ${e?.message || e}`);
    return false;
  }
}

async function testStorageItemWithArgs(api, name, queryFn, args, description = '') {
  try {
    const result = await queryFn(...args);
    console.log(`[${name}] ✅ ${description}`);
    if (result !== null && result !== undefined) {
      if (typeof result === 'object' && result.isSome !== undefined) {
        console.log(`  - isSome: ${result.isSome}`);
        if (result.isSome) {
          const unwrapped = result.unwrap();
          console.log(`  - value: ${unwrapped?.toString?.() || JSON.stringify(unwrapped)}`);
        }
      } else {
        console.log(`  - value: ${result?.toString?.() || JSON.stringify(result)}`);
      }
    }
    return true;
  } catch (e) {
    console.log(`[${name}] ❌ ${e?.message || e}`);
    return false;
  }
}

async function testMapStorage(api, name, queryFn, description = '') {
  try {
    const entries = await queryFn.entries();
    console.log(`[${name}] ✅ ${description}`);
    console.log(`  - entries count: ${entries.length}`);
    
    if (entries.length > 0) {
      // Show first few entries
      const sampleEntries = entries.slice(0, 3);
      for (let i = 0; i < sampleEntries.length; i++) {
        const [key, value] = sampleEntries[i];
        const keyArgs = key.args.map(a => a.toString());
        console.log(`  - entry ${i}: key=${keyArgs.join(',')} value=${value?.toString?.() || JSON.stringify(value)}`);
      }
    }
    return true;
  } catch (e) {
    console.log(`[${name}] ❌ ${e?.message || e}`);
    return false;
  }
}

async function main() {
  console.log(`[connect] ${WS}`);
  const api = await activate({ rpcUrl: WS });

  const head = await api.rpc.chain.getHeader();
  const headHash = await api.rpc.chain.getBlockHash(head.number.toNumber());
  const atHead = await api.at(headHash);
  
  console.log(`[head] block #${head.number.toString()} • hash: ${headHash.toString()}`);

  const domainsQuery = api.query?.domains;
  if (!domainsQuery) {
    console.log('[error] domains query not available');
    return;
  }

  console.log('\n=== DOMAINS STORAGE ITEMS EXPLORATION ===\n');

  // Test all available storage items
  const storageTests = [
    // Basic domain info
    {
      name: 'domainRegistry',
      test: () => testStorageItemWithArgs(atHead, 'domainRegistry', atHead.query.domains.domainRegistry, [DOMAIN_ID], 'Domain registry information')
    },
    {
      name: 'domainStakingSummary',
      test: () => testStorageItemWithArgs(atHead, 'domainStakingSummary', atHead.query.domains.domainStakingSummary, [DOMAIN_ID], 'Domain staking summary')
    },
    
    // Operators
    {
      name: 'operators',
      test: () => testMapStorage(atHead, 'operators', atHead.query.domains.operators, 'All operators')
    },
    {
      name: 'operatorEpochSharePrice',
      test: () => testMapStorage(atHead, 'operatorEpochSharePrice', atHead.query.domains.operatorEpochSharePrice, 'Operator epoch share prices')
    },
    {
      name: 'operatorHighestSlot',
      test: () => testMapStorage(atHead, 'operatorHighestSlot', atHead.query.domains.operatorHighestSlot, 'Operator highest slots')
    },
    {
      name: 'operatorBundleSlot',
      test: () => testMapStorage(atHead, 'operatorBundleSlot', atHead.query.domains.operatorBundleSlot, 'Operator bundle slots')
    },
    
    // Deposits and withdrawals
    {
      name: 'deposits',
      test: () => testMapStorage(atHead, 'deposits', atHead.query.domains.deposits, 'All deposits')
    },
    {
      name: 'withdrawals',
      test: () => testMapStorage(atHead, 'withdrawals', atHead.query.domains.withdrawals, 'All withdrawals')
    },
    {
      name: 'depositOnHold',
      test: () => testMapStorage(atHead, 'depositOnHold', atHead.query.domains.depositOnHold, 'Deposits on hold')
    },
    
    // Financial metrics
    {
      name: 'accumulatedTreasuryFunds',
      test: () => testStorageItem(atHead, 'accumulatedTreasuryFunds', () => atHead.query.domains.accumulatedTreasuryFunds(), 'Accumulated treasury funds')
    },
    {
      name: 'domainChainRewards',
      test: () => testStorageItemWithArgs(atHead, 'domainChainRewards', atHead.query.domains.domainChainRewards, [DOMAIN_ID], 'Domain chain rewards')
    },
    
    // Bundle and execution metrics
    {
      name: 'successfulBundles',
      test: () => testMapStorage(atHead, 'successfulBundles', atHead.query.domains.successfulBundles, 'Successful bundles')
    },
    {
      name: 'blockTree',
      test: () => testMapStorage(atHead, 'blockTree', atHead.query.domains.blockTree, 'Block tree')
    },
    {
      name: 'blockTreeNodes',
      test: () => testMapStorage(atHead, 'blockTreeNodes', atHead.query.domains.blockTreeNodes, 'Block tree nodes')
    },
    {
      name: 'executionInbox',
      test: () => testMapStorage(atHead, 'executionInbox', atHead.query.domains.executionInbox, 'Execution inbox')
    },
    {
      name: 'inboxedBundleAuthor',
      test: () => testMapStorage(atHead, 'inboxedBundleAuthor', atHead.query.domains.inboxedBundleAuthor, 'Inboxed bundle authors')
    },
    
    // Domain state
    {
      name: 'headDomainNumber',
      test: () => testStorageItem(atHead, 'headDomainNumber', () => atHead.query.domains.headDomainNumber(), 'Head domain number')
    },
    {
      name: 'headReceiptNumber',
      test: () => testStorageItem(atHead, 'headReceiptNumber', () => atHead.query.domains.headReceiptNumber(), 'Head receipt number')
    },
    {
      name: 'newAddedHeadReceipt',
      test: () => testStorageItem(atHead, 'newAddedHeadReceipt', () => atHead.query.domains.newAddedHeadReceipt(), 'New added head receipt')
    },
    {
      name: 'consensusBlockHash',
      test: () => testStorageItem(atHead, 'consensusBlockHash', () => atHead.query.domains.consensusBlockHash(), 'Consensus block hash')
    },
    
    // Execution receipts
    {
      name: 'latestConfirmedDomainExecutionReceipt',
      test: () => testMapStorage(atHead, 'latestConfirmedDomainExecutionReceipt', atHead.query.domains.latestConfirmedDomainExecutionReceipt, 'Latest confirmed domain execution receipts')
    },
    {
      name: 'domainGenesisBlockExecutionReceipt',
      test: () => testMapStorage(atHead, 'domainGenesisBlockExecutionReceipt', atHead.query.domains.domainGenesisBlockExecutionReceipt, 'Domain genesis block execution receipts')
    },
    {
      name: 'latestSubmittedER',
      test: () => testMapStorage(atHead, 'latestSubmittedER', atHead.query.domains.latestSubmittedER, 'Latest submitted execution receipts')
    },
    
    // Staking distribution
    {
      name: 'lastEpochStakingDistribution',
      test: () => testMapStorage(atHead, 'lastEpochStakingDistribution', atHead.query.domains.lastEpochStakingDistribution, 'Last epoch staking distribution')
    },
    
    // Pending operations
    {
      name: 'pendingSlashes',
      test: () => testMapStorage(atHead, 'pendingSlashes', atHead.query.domains.pendingSlashes, 'Pending slashes')
    },
    {
      name: 'pendingStakingOperationCount',
      test: () => testStorageItem(atHead, 'pendingStakingOperationCount', () => atHead.query.domains.pendingStakingOperationCount(), 'Pending staking operation count')
    },
    
    // Domain configuration
    {
      name: 'nextOperatorId',
      test: () => testStorageItem(atHead, 'nextOperatorId', () => atHead.query.domains.nextOperatorId(), 'Next operator ID')
    },
    {
      name: 'nextDomainId',
      test: () => testStorageItem(atHead, 'nextDomainId', () => atHead.query.domains.nextDomainId(), 'Next domain ID')
    },
    {
      name: 'operatorIdOwner',
      test: () => testMapStorage(atHead, 'operatorIdOwner', atHead.query.domains.operatorIdOwner, 'Operator ID owners')
    },
    
    // Runtime and upgrades
    {
      name: 'nextRuntimeId',
      test: () => testStorageItem(atHead, 'nextRuntimeId', () => atHead.query.domains.nextRuntimeId(), 'Next runtime ID')
    },
    {
      name: 'nextEVMChainId',
      test: () => testStorageItem(atHead, 'nextEVMChainId', () => atHead.query.domains.nextEVMChainId(), 'Next EVM chain ID')
    },
    {
      name: 'runtimeRegistry',
      test: () => testMapStorage(atHead, 'runtimeRegistry', atHead.query.domains.runtimeRegistry, 'Runtime registry')
    },
    {
      name: 'scheduledRuntimeUpgrades',
      test: () => testMapStorage(atHead, 'scheduledRuntimeUpgrades', atHead.query.domains.scheduledRuntimeUpgrades, 'Scheduled runtime upgrades')
    },
    {
      name: 'domainRuntimeUpgradeRecords',
      test: () => testMapStorage(atHead, 'domainRuntimeUpgradeRecords', atHead.query.domains.domainRuntimeUpgradeRecords, 'Domain runtime upgrade records')
    },
    {
      name: 'domainRuntimeUpgrades',
      test: () => testMapStorage(atHead, 'domainRuntimeUpgrades', atHead.query.domains.domainRuntimeUpgrades, 'Domain runtime upgrades')
    },
    
    // Other metrics
    {
      name: 'frozenDomains',
      test: () => testMapStorage(atHead, 'frozenDomains', atHead.query.domains.frozenDomains, 'Frozen domains')
    },
    {
      name: 'invalidBundleAuthors',
      test: () => testMapStorage(atHead, 'invalidBundleAuthors', atHead.query.domains.invalidBundleAuthors, 'Invalid bundle authors')
    },
    {
      name: 'domainTxRangeState',
      test: () => testMapStorage(atHead, 'domainTxRangeState', atHead.query.domains.domainTxRangeState, 'Domain transaction range state')
    }
  ];

  // Run all tests
  for (const test of storageTests) {
    await test.test();
    console.log(''); // Add spacing
  }

  // Test historical data for a few epochs
  console.log('\n=== HISTORICAL DATA TEST ===\n');
  try {
    const headEpoch = await epochAt(api, head.number.toNumber());
    console.log(`[current.epoch] ${headEpoch}`);
    
    // Test a few recent epochs
    for (let epoch = Math.max(0, headEpoch - 2); epoch <= headEpoch; epoch++) {
      try {
        const startBlock = await findEpochStartBlock(api, epoch);
        const nextStart = await findEpochStartBlock(api, epoch + 1);
        const endBlock = nextStart - 1;
        const endHash = await api.rpc.chain.getBlockHash(endBlock);
        const atEnd = await api.at(endHash);
        
        console.log(`[epoch.${epoch}] endBlock=${endBlock}`);
        
        // Test key metrics at epoch end
        await testStorageItemWithArgs(atEnd, `epoch.${epoch}.domainStakingSummary`, atEnd.query.domains.domainStakingSummary, [DOMAIN_ID], 'Domain staking summary');
        await testStorageItem(atEnd, `epoch.${epoch}.accumulatedTreasuryFunds`, () => atEnd.query.domains.accumulatedTreasuryFunds(), 'Accumulated treasury funds');
        await testStorageItemWithArgs(atEnd, `epoch.${epoch}.domainChainRewards`, atEnd.query.domains.domainChainRewards, [DOMAIN_ID], 'Domain chain rewards');
        
        // Test deposits and withdrawals at epoch end
        const deposits = await atEnd.query.domains.deposits.entries();
        const withdrawals = await atEnd.query.domains.withdrawals.entries();
        console.log(`[epoch.${epoch}.deposits] ✅ entries count: ${deposits.length}`);
        console.log(`[epoch.${epoch}.withdrawals] ✅ entries count: ${withdrawals.length}`);
        
        // Test successful bundles at epoch end
        const successfulBundles = await atEnd.query.domains.successfulBundles.entries();
        console.log(`[epoch.${epoch}.successfulBundles] ✅ entries count: ${successfulBundles.length}`);
        
      } catch (e) {
        console.warn(`[epoch.${epoch}.error]`, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[historical.test.error]', e?.message || e);
  }

  await api.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
