import { activate } from '@autonomys/auto-utils';

const RPC_USER = process.env.RPC_USER || 'your_username';
const RPC_PASS = process.env.RPC_PASS || 'your_password';
const WS = process.env.RPC_URL_WS || 'wss://rpc.anoncenomics.com/ws';

async function diagnosePerformance() {
  console.log('🔍 Performance Diagnosis');
  console.log('=======================');
  
  try {
    const api = await activate({ rpcUrl: WS, rpcUser: RPC_USER, rpcPass: RPC_PASS });
    console.log('✅ Connected to RPC endpoint');
    
    // Get current chain state
    const head = await api.rpc.chain.getHeader();
    console.log(`📊 Current block: #${head.number.toNumber()}`);
    
    // Check what domain queries are available
    console.log('\n🔍 Checking available domain queries...');
    
    const domainQueries = [
      'domainStakingSummary',
      'domainRegistry', 
      'accumulatedTreasuryFunds',
      'domainChainRewards',
      'pendingStakingOperationCount',
      'headDomainNumber',
      'headReceiptNumber',
      'newAddedHeadReceipt',
      'consensusBlockHash'
    ];
    
    for (const query of domainQueries) {
      try {
        if (query === 'domainStakingSummary') {
          const result = await api.query.domains[query](0);
          console.log(`✅ ${query}: Available`);
          if (result && result.isSome) {
            const data = result.unwrap();
            const epoch = data.currentEpochIndex ?? data.epochIndex ?? data.epoch;
            console.log(`   Current epoch: ${epoch.toNumber()}`);
          }
        } else if (query === 'accumulatedTreasuryFunds') {
          const result = await api.query.domains[query]();
          console.log(`✅ ${query}: Available`);
        } else {
          const result = await api.query.domains[query](0);
          console.log(`✅ ${query}: Available`);
        }
      } catch (e) {
        console.log(`❌ ${query}: ${e.message}`);
      }
    }
    
    // Check collection queries
    console.log('\n🔍 Checking collection queries...');
    const collectionQueries = [
      'deposits',
      'withdrawals', 
      'depositOnHold',
      'successfulBundles',
      'operatorEpochSharePrice',
      'operatorHighestSlot',
      'operatorBundleSlot',
      'pendingSlashes',
      'lastEpochStakingDistribution',
      'invalidBundleAuthors',
      'latestConfirmedDomainExecutionReceipt',
      'domainGenesisBlockExecutionReceipt',
      'latestSubmittedER',
      'operators'
    ];
    
    for (const query of collectionQueries) {
      try {
        const result = await api.query.domains[query].entries();
        console.log(`✅ ${query}: Available (${result.length} entries)`);
      } catch (e) {
        console.log(`❌ ${query}: ${e.message}`);
      }
    }
    
    // Performance test
    console.log('\n⚡ Performance Test');
    console.log('Testing query speed...');
    
    const startTime = Date.now();
    const endHash = await api.rpc.chain.getBlockHash(head.number.toNumber());
    const atEnd = await api.at(endHash);
    
    // Test a few key queries
    const queries = [
      atEnd.query.domains.domainStakingSummary(0),
      atEnd.query.domains.domainRegistry(0),
      atEnd.query.domains.accumulatedTreasuryFunds(),
      atEnd.query.domains.operators.entries()
    ];
    
    const results = await Promise.all(queries);
    const endTime = Date.now();
    
    console.log(`⏱️  Query time: ${endTime - startTime}ms`);
    console.log(`📊 Operators found: ${results[3].length}`);
    
    // Check if we can find epoch boundaries
    console.log('\n🔍 Testing epoch boundary detection...');
    try {
      const epoch = await findEpochAt(api, head.number.toNumber());
      console.log(`✅ Current epoch: ${epoch}`);
      
      // Test finding epoch start
      const epochStart = await findEpochStartBlock(api, epoch);
      console.log(`✅ Epoch ${epoch} starts at block: ${epochStart}`);
    } catch (e) {
      console.log(`❌ Epoch detection failed: ${e.message}`);
    }
    
    await api.disconnect();
    
  } catch (e) {
    console.error('❌ Diagnosis failed:', e.message);
  }
}

async function findEpochAt(api, blockNumber) {
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  const at = await api.at(hash);
  const opt = await at.query.domains.domainStakingSummary(0);
  if (!opt || opt.isNone) return null;
  const s = opt.unwrap();
  const epoch = s.currentEpochIndex ?? s.epochIndex ?? s.epoch;
  return typeof epoch?.toNumber === 'function' ? epoch.toNumber() : Number(epoch);
}

async function findEpochStartBlock(api, targetEpoch) {
  const head = await api.rpc.chain.getHeader();
  let lo = 1, hi = head.number.toNumber();
  let ans = null;
  const cur = await findEpochAt(api, hi);
  if (cur == null) throw new Error('Cannot read epoch at head');
  if (targetEpoch > cur) throw new Error(`target epoch ${targetEpoch} > current ${cur}`);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const e = await findEpochAt(api, mid);
    if (e == null) { lo = mid + 1; continue; }
    if (e >= targetEpoch) { ans = mid; hi = mid; } else { lo = mid + 1; }
  }
  const eLo = await findEpochAt(api, lo);
  if (eLo !== targetEpoch) throw new Error(`Failed to locate start: epoch@${lo}=${eLo}`);
  return lo;
}

diagnosePerformance();
