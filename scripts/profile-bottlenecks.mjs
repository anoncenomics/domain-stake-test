import { activate } from '@autonomys/auto-utils';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node profile-bottlenecks.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com/ws)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --domain <id>        Domain ID to query (default: 0)
  --epoch <n>          Epoch to profile (default: 0)
  --iterations <n>     Number of iterations to run (default: 3)
  --help, -h           Show this help message

Examples:
  # Profile epoch 0 with 3 iterations
  node profile-bottlenecks.mjs --epoch 0

  # Profile specific epoch with more iterations
  node profile-bottlenecks.mjs --epoch 100 --iterations 5
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return process.env[k.toUpperCase()] ?? d;
};

const WS = getArg('ws', process.env.RPC_URL_WS || 'wss://rpc.anoncenomics.com/ws');
const RPC_USER = getArg('user', process.env.RPC_USER || '');
const RPC_PASS = getArg('pass', process.env.RPC_PASS || '');
const DOMAIN_ID = Number(getArg('domain', '0'));
const TARGET_EPOCH = Number(getArg('epoch', '0'));
const ITERATIONS = Number(getArg('iterations', '3'));

// Profiling utilities
function timeAsync(fn, name) {
  return async (...args) => {
    const start = performance.now();
    const result = await fn(...args);
    const end = performance.now();
    return { result, duration: end - start, name };
  };
}

function timeSync(fn, name) {
  return (...args) => {
    const start = performance.now();
    const result = fn(...args);
    const end = performance.now();
    return { result, duration: end - start, name };
  };
}

// Profiled functions
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

function mapToArray(m) {
  if (!m || !m.entries) return [];
  const out = [];
  try {
    for (const [k, v] of m.entries()) {
      const key = k.args ? k.args.map(a => a.toString()) : [k.toString()];
      out.push({ key, value: v?.toString?.() || JSON.stringify(v) });
    }
  } catch (e) {
    console.warn(`[mapToArray] error: ${e.message}`);
  }
  return out;
}

async function getComprehensiveMetrics(api, epoch, endBlock) {
  const endHash = await api.rpc.chain.getBlockHash(endBlock);
  const atEnd = await api.at(endHash);
  
  // Profile individual RPC calls
  const rpcCalls = [
    { name: 'domainStakingSummary', fn: () => atEnd.query.domains.domainStakingSummary(DOMAIN_ID) },
    { name: 'domainRegistry', fn: () => atEnd.query.domains.domainRegistry(DOMAIN_ID) },
    { name: 'accumulatedTreasuryFunds', fn: () => atEnd.query.domains.accumulatedTreasuryFunds() },
    { name: 'domainChainRewards', fn: () => atEnd.query.domains.domainChainRewards(DOMAIN_ID) },
    { name: 'deposits.entries', fn: () => atEnd.query.domains.deposits.entries() },
    { name: 'withdrawals.entries', fn: () => atEnd.query.domains.withdrawals.entries() },
    { name: 'depositOnHold.entries', fn: () => atEnd.query.domains.depositOnHold.entries() },
    { name: 'successfulBundles.entries', fn: () => atEnd.query.domains.successfulBundles.entries() },
    { name: 'operatorEpochSharePrice.entries', fn: () => atEnd.query.domains.operatorEpochSharePrice.entries() },
    { name: 'operatorHighestSlot.entries', fn: () => atEnd.query.domains.operatorHighestSlot.entries() },
    { name: 'operatorBundleSlot.entries', fn: () => atEnd.query.domains.operatorBundleSlot.entries() },
    { name: 'pendingStakingOperationCount', fn: () => atEnd.query.domains.pendingStakingOperationCount(DOMAIN_ID) },
    { name: 'pendingSlashes.entries', fn: () => atEnd.query.domains.pendingSlashes.entries() },
    { name: 'lastEpochStakingDistribution.entries', fn: () => atEnd.query.domains.lastEpochStakingDistribution.entries() },
    { name: 'invalidBundleAuthors.entries', fn: () => atEnd.query.domains.invalidBundleAuthors.entries() },
    { name: 'headDomainNumber', fn: () => atEnd.query.domains.headDomainNumber(DOMAIN_ID) },
    { name: 'headReceiptNumber', fn: () => atEnd.query.domains.headReceiptNumber(DOMAIN_ID) },
    { name: 'newAddedHeadReceipt', fn: () => atEnd.query.domains.newAddedHeadReceipt(DOMAIN_ID) },
    { name: 'consensusBlockHash', fn: () => atEnd.query.domains.consensusBlockHash(DOMAIN_ID, 0) },
    { name: 'latestConfirmedDomainExecutionReceipt.entries', fn: () => atEnd.query.domains.latestConfirmedDomainExecutionReceipt.entries() },
    { name: 'domainGenesisBlockExecutionReceipt.entries', fn: () => atEnd.query.domains.domainGenesisBlockExecutionReceipt.entries() },
    { name: 'latestSubmittedER.entries', fn: () => atEnd.query.domains.latestSubmittedER.entries() },
    { name: 'operators.entries', fn: () => atEnd.query.domains.operators.entries() }
  ];

  const rpcResults = {};
  const rpcTimings = {};

  // Run RPC calls sequentially to measure individual performance
  for (const call of rpcCalls) {
    const start = performance.now();
    rpcResults[call.name] = await call.fn();
    const end = performance.now();
    rpcTimings[call.name] = end - start;
  }

  // Profile data processing
  const processingStart = performance.now();
  
  // Calculate totals from operators
  let totalStorageFeeDeposit = 0;
  let totalStake = 0;
  let totalShares = 0;
  
  const operators = rpcResults['operators.entries'];
  for (const [key, operator] of operators) {
    if (operator) {
      if (operator.totalStorageFeeDeposit) {
        totalStorageFeeDeposit += BigInt(operator.totalStorageFeeDeposit.toString());
      }
      if (operator.currentTotalStake) {
        totalStake += BigInt(operator.currentTotalStake.toString());
      }
      if (operator.currentTotalShares) {
        totalShares += BigInt(operator.currentTotalShares.toString());
      }
    }
  }

  // Profile mapToArray operations
  const mapTimings = {};
  const dataProcessing = [
    { name: 'deposits', data: rpcResults['deposits.entries'] },
    { name: 'withdrawals', data: rpcResults['withdrawals.entries'] },
    { name: 'depositOnHold', data: rpcResults['depositOnHold.entries'] },
    { name: 'successfulBundles', data: rpcResults['successfulBundles.entries'] },
    { name: 'operatorEpochSharePrice', data: rpcResults['operatorEpochSharePrice.entries'] },
    { name: 'operatorHighestSlot', data: rpcResults['operatorHighestSlot.entries'] },
    { name: 'operatorBundleSlot', data: rpcResults['operatorBundleSlot.entries'] },
    { name: 'pendingSlashes', data: rpcResults['pendingSlashes.entries'] },
    { name: 'lastEpochStakingDistribution', data: rpcResults['lastEpochStakingDistribution.entries'] },
    { name: 'invalidBundleAuthors', data: rpcResults['invalidBundleAuthors.entries'] },
    { name: 'latestConfirmedDomainExecutionReceipt', data: rpcResults['latestConfirmedDomainExecutionReceipt.entries'] },
    { name: 'domainGenesisBlockExecutionReceipt', data: rpcResults['domainGenesisBlockExecutionReceipt.entries'] },
    { name: 'latestSubmittedER', data: rpcResults['latestSubmittedER.entries'] },
    { name: 'operators', data: operators }
  ];

  for (const item of dataProcessing) {
    const start = performance.now();
    mapToArray(item.data);
    const end = performance.now();
    mapTimings[item.name] = end - start;
  }

  const processingEnd = performance.now();
  const totalProcessingTime = processingEnd - processingStart;

  return {
    rpcTimings,
    mapTimings,
    totalProcessingTime,
    dataSizes: Object.fromEntries(
      Object.entries(rpcResults).map(([name, data]) => [
        name, 
        data?.length || (typeof data === 'string' ? data.length : JSON.stringify(data).length)
      ])
    )
  };
}

async function profileEpoch(api, epoch) {
  console.log(`\n[profile] Profiling epoch ${epoch}...`);
  
  const timings = {
    findEpochStartBlock: 0,
    findEpochEndBlock: 0,
    getComprehensiveMetrics: 0,
    total: 0
  };

  const start = performance.now();
  
  // Profile findEpochStartBlock
  const startBlockStart = performance.now();
  const startBlock = await findEpochStartBlock(api, epoch);
  const startBlockEnd = performance.now();
  timings.findEpochStartBlock = startBlockEnd - startBlockStart;
  
  // Profile findEpochEndBlock
  const endBlockStart = performance.now();
  const nextStart = await findEpochStartBlock(api, epoch + 1);
  const endBlock = nextStart - 1;
  const endBlockEnd = performance.now();
  timings.findEpochEndBlock = endBlockEnd - endBlockStart;
  
  // Profile getComprehensiveMetrics
  const metricsStart = performance.now();
  const metrics = await getComprehensiveMetrics(api, epoch, endBlock);
  const metricsEnd = performance.now();
  timings.getComprehensiveMetrics = metricsEnd - metricsStart;
  
  const end = performance.now();
  timings.total = end - start;

  return {
    epoch,
    startBlock,
    endBlock,
    timings,
    metrics
  };
}

async function main() {
  console.log(`[profile] Starting bottleneck analysis`);
  console.log(`[config] Domain ${DOMAIN_ID}, Epoch ${TARGET_EPOCH}, Iterations ${ITERATIONS}`);
  console.log(`[config] RPC: ${WS}`);
  
  const api = await activate({ rpcUrl: WS, rpcUser: RPC_USER, rpcPass: RPC_PASS });
  
  try {
    // Test connection
    const head = await api.rpc.chain.getHeader();
    console.log(`[connected] block #${head.number.toNumber()}`);
    
    const results = [];
    
    for (let i = 0; i < ITERATIONS; i++) {
      console.log(`\n[iteration] ${i + 1}/${ITERATIONS}`);
      const result = await profileEpoch(api, TARGET_EPOCH);
      results.push(result);
      
      // Small delay between iterations
      if (i < ITERATIONS - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Analyze results
    console.log(`\n${'='.repeat(80)}`);
    console.log(`BOTTLENECK ANALYSIS RESULTS`);
    console.log(`${'='.repeat(80)}`);
    
    // Calculate averages
    const avgTimings = {
      findEpochStartBlock: 0,
      findEpochEndBlock: 0,
      getComprehensiveMetrics: 0,
      total: 0
    };
    
    const avgRpcTimings = {};
    const avgMapTimings = {};
    const avgDataSizes = {};
    
    results.forEach(result => {
      Object.keys(avgTimings).forEach(key => {
        avgTimings[key] += result.timings[key];
      });
      
      Object.entries(result.metrics.rpcTimings).forEach(([name, time]) => {
        avgRpcTimings[name] = (avgRpcTimings[name] || 0) + time;
      });
      
      Object.entries(result.metrics.mapTimings).forEach(([name, time]) => {
        avgMapTimings[name] = (avgMapTimings[name] || 0) + time;
      });
      
      Object.entries(result.metrics.dataSizes).forEach(([name, size]) => {
        avgDataSizes[name] = (avgDataSizes[name] || 0) + size;
      });
    });
    
    // Calculate averages
    Object.keys(avgTimings).forEach(key => {
      avgTimings[key] /= ITERATIONS;
    });
    
    Object.keys(avgRpcTimings).forEach(key => {
      avgRpcTimings[key] /= ITERATIONS;
    });
    
    Object.keys(avgMapTimings).forEach(key => {
      avgMapTimings[key] /= ITERATIONS;
    });
    
    Object.keys(avgDataSizes).forEach(key => {
      avgDataSizes[key] = Math.round(avgDataSizes[key] / ITERATIONS);
    });
    
    // Display results
    console.log(`\n📊 TIMING BREAKDOWN (averages over ${ITERATIONS} iterations):`);
    console.log(`   Total time:           ${avgTimings.total.toFixed(2)}ms`);
    console.log(`   ├─ Find start block:  ${avgTimings.findEpochStartBlock.toFixed(2)}ms (${(avgTimings.findEpochStartBlock/avgTimings.total*100).toFixed(1)}%)`);
    console.log(`   ├─ Find end block:    ${avgTimings.findEpochEndBlock.toFixed(2)}ms (${(avgTimings.findEpochEndBlock/avgTimings.total*100).toFixed(1)}%)`);
    console.log(`   └─ Get metrics:       ${avgTimings.getComprehensiveMetrics.toFixed(2)}ms (${(avgTimings.getComprehensiveMetrics/avgTimings.total*100).toFixed(1)}%)`);
    
    // Identify bottlenecks
    const bottlenecks = [];
    if (avgTimings.findEpochStartBlock > avgTimings.total * 0.3) {
      bottlenecks.push('Epoch boundary detection (binary search)');
    }
    if (avgTimings.getComprehensiveMetrics > avgTimings.total * 0.5) {
      bottlenecks.push('RPC calls and data processing');
    }
    
    console.log(`\n🔍 BOTTLENECK IDENTIFICATION:`);
    if (bottlenecks.length === 0) {
      console.log(`   ✅ No major bottlenecks identified`);
    } else {
      bottlenecks.forEach(bottleneck => {
        console.log(`   ⚠️  ${bottleneck}`);
      });
    }
    
    // RPC call analysis
    console.log(`\n🌐 RPC CALL PERFORMANCE (slowest first):`);
    const sortedRpc = Object.entries(avgRpcTimings)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10);
    
    sortedRpc.forEach(([name, time]) => {
      console.log(`   ${name.padEnd(40)} ${time.toFixed(2)}ms`);
    });
    
    // Data processing analysis
    console.log(`\n⚙️  DATA PROCESSING PERFORMANCE:`);
    const sortedMap = Object.entries(avgMapTimings)
      .sort(([,a], [,b]) => b - a);
    
    sortedMap.forEach(([name, time]) => {
      const size = avgDataSizes[name] || 0;
      console.log(`   ${name.padEnd(30)} ${time.toFixed(2)}ms (${size} items)`);
    });
    
    // Recommendations
    console.log(`\n💡 RECOMMENDATIONS:`);
    
    if (avgTimings.findEpochStartBlock > avgTimings.total * 0.3) {
      console.log(`   • Epoch boundary detection is slow - consider caching epoch boundaries`);
      console.log(`   • Binary search could be optimized with better initial bounds`);
    }
    
    const slowestRpc = sortedRpc[0];
    if (slowestRpc && slowestRpc[1] > 100) {
      console.log(`   • RPC call '${slowestRpc[0]}' is slow (${slowestRpc[1].toFixed(2)}ms) - check RPC endpoint performance`);
    }
    
    const totalRpcTime = Object.values(avgRpcTimings).reduce((a, b) => a + b, 0);
    console.log(`   • Total RPC time: ${totalRpcTime.toFixed(2)}ms (${(totalRpcTime/avgTimings.total*100).toFixed(1)}% of total)`);
    console.log(`   • CPU processing time: ${(avgTimings.total - totalRpcTime).toFixed(2)}ms (${((avgTimings.total - totalRpcTime)/avgTimings.total*100).toFixed(1)}% of total)`);
    
    if (totalRpcTime > avgTimings.total * 0.8) {
      console.log(`   • 🚨 RPC is the primary bottleneck - stronger CPU won't help much`);
      console.log(`   • Consider: better RPC endpoint, connection pooling, request batching`);
    } else {
      console.log(`   • ✅ CPU processing is significant - stronger CPU could help`);
      console.log(`   • Consider: more CPU cores, faster single-thread performance`);
    }
    
  } finally {
    await api.disconnect();
  }
}

main().catch(e => {
  console.error(`[fatal] ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
