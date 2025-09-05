// Node.js examples for Autonomys/Subspace RPC
// Note: @polkadot/api HttpProvider has auth issues with this endpoint
// This example uses native fetch for reliable authentication

const RPC_URL_HTTP = process.env.RPC_URL_HTTP || process.env.RPC_URL || 'https://rpc.anoncenomics.com';
const RPC_URL_WS   = process.env.RPC_URL_WS   || process.env.RPC_URL?.replace('https://', 'wss://') || 'wss://rpc.anoncenomics.com';
const RPC_USER     = process.env.RPC_USER     || '';
const RPC_PASS     = process.env.RPC_PASS     || '';

// Validate required environment variables
if (!RPC_USER || !RPC_PASS) {
  console.error('❌ Error: RPC_USER and RPC_PASS environment variables are required');
  console.error('Please set them in your .env file or environment:');
  console.error('  export RPC_USER=your_username');
  console.error('  export RPC_PASS=your_password');
  process.exit(1);
}

// Create auth header exactly like the working curl example
const auth = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64').replace(/\n/g, '');

// Native fetch RPC client (works reliably)
async function rpcCall(method, params = []) {
  const response = await fetch(RPC_URL_HTTP, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: method,
      params: params,
      id: 1
    })
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  if (data.error) {
    throw new Error(`RPC Error: ${data.error.message}`);
  }
  
  return data.result;
}

async function httpExample() {
  console.log('\n=== HTTP Example (Native Fetch) ===');
  try {
    console.log('system_chain:', await rpcCall('system_chain'));
    console.log('system_version:', await rpcCall('system_version'));
    console.log('system_health:', await rpcCall('system_health'));
    
    const header = await rpcCall('chain_getHeader');
    console.log('chain_getHeader:', JSON.stringify(header, null, 2));
  } catch (error) {
    console.error('HTTP Error:', error.message);
  }
}

async function wsExample() {
  console.log('\n=== WebSocket Example ===');
  console.log('Note: WebSocket with auth headers requires Node.js');
  console.log('The @polkadot/api WsProvider may have auth issues similar to HttpProvider');
  console.log('For production use, consider using HTTP or implementing custom WebSocket client');
}

// Polkadot API example (may not work due to auth issues)
async function polkadotApiExample() {
  console.log('\n=== Polkadot API Example (May Fail) ===');
  try {
    // Try to import and use @polkadot/api
    const { ApiPromise, HttpProvider } = await import('@polkadot/api');
    
    const provider = new HttpProvider(RPC_URL_HTTP, { 
      headers: { Authorization: auth }
    });
    const api = await ApiPromise.create({ provider });
    
    console.log('system_chain (Polkadot API):', (await api.rpc.system.chain()).toHuman());
    console.log('system_version (Polkadot API):', (await api.rpc.system.version()).toHuman());
    
    await api.disconnect();
  } catch (error) {
    console.error('Polkadot API Error (expected):', error.message);
    console.log('This is a known issue with @polkadot/api and authenticated endpoints');
  }
}

(async () => {
  await httpExample();
  await wsExample();
  await polkadotApiExample();
})().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
