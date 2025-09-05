import { activate } from '@autonomys/auto-utils';

const argv = process.argv.slice(2);

// Display help if requested
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
Usage: node test-node-connection.mjs [options]

Options:
  --ws <url>           WebSocket RPC endpoint (default: wss://rpc.anoncenomics.com)
  --user <username>    RPC username for authentication
  --pass <password>    RPC password for authentication
  --help, -h           Show this help message

Environment Variables:
  RPC_URL_WS           WebSocket RPC endpoint (overrides --ws)
  RPC_USER             RPC username (overrides --user)
  RPC_PASS             RPC password (overrides --pass)

Examples:
  # Test authenticated Autonomys node (default)
  node test-node-connection.mjs --user your_username --pass your_password

  # Test using environment variables (recommended)
  export RPC_USER=your_username
  export RPC_PASS=your_password
  node test-node-connection.mjs

  # Test using .env file
  export $(cat .env | xargs)
  node test-node-connection.mjs

  # Test different node
  node test-node-connection.mjs --ws wss://other-node:9944
`);
  process.exit(0);
}

const getArg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  if (i !== -1 && argv[i+1] && !argv[i+1].startsWith('--')) return argv[i+1];
  return process.env[k.toUpperCase()] ?? d;
};

const WS = getArg('ws', 'wss://rpc.anoncenomics.com');
const RPC_USER = getArg('user', process.env.RPC_USER || '');
const RPC_PASS = getArg('pass', process.env.RPC_PASS || '');

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
  console.error('4. Test different node:');
  console.error('   --ws wss://other-node:9944');
  process.exit(1);
}

async function testConnection() {
  console.log(`[test] Connecting to ${WS}...`);
  
  if (RPC_USER && RPC_PASS) {
    console.log(`[auth] Using credentials for user: ${RPC_USER}`);
  }
  
  try {
    const api = await activate({ rpcUrl: WS, rpcUser: RPC_USER, rpcPass: RPC_PASS });
    console.log(`[✓] Connected successfully!`);
    
    // Get basic chain info
    const head = await api.rpc.chain.getHeader();
    console.log(`[✓] Current block: #${head.number.toNumber()}`);
    console.log(`[✓] Block hash: ${head.hash.toString()}`);
    
    // Get chain name and version
    try {
      const [chain, version] = await Promise.all([
        api.rpc.system.chain(),
        api.rpc.system.version()
      ]);
      console.log(`[✓] Chain: ${chain.toString()}`);
      console.log(`[✓] Version: ${version.toString()}`);
    } catch (e) {
      console.log(`[!] Could not get chain info: ${e.message}`);
    }
    
    // Test domain queries
    try {
      const domainCount = await api.query.domains.domainCount();
      console.log(`[✓] Total domains: ${domainCount.toNumber()}`);
      
      // Test domain staking summary for domain 0
      const summary = await api.query.domains.domainStakingSummary(0);
      if (summary && summary.isSome) {
        const s = summary.unwrap();
        const epoch = s.currentEpochIndex ?? s.epochIndex ?? s.epoch;
        console.log(`[✓] Domain 0 current epoch: ${epoch.toNumber()}`);
      } else {
        console.log(`[!] No staking summary available for domain 0`);
      }
    } catch (e) {
      console.log(`[!] Domain queries failed: ${e.message}`);
    }
    
    await api.disconnect();
    console.log(`[✓] Node is ready for use with backfill-epochs-with-storage-fees.mjs`);
    
  } catch (e) {
    console.error(`[✗] Connection failed: ${e.message}`);
    console.error(`[✗] Make sure your node is running and accessible at ${WS}`);
    if (RPC_USER && RPC_PASS) {
      console.error(`[✗] Check your authentication credentials`);
    }
    process.exit(1);
  }
}

testConnection().catch(e => {
  console.error(e);
  process.exit(1);
});
