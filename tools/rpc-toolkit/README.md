# Autonomys / Subspace Private RPC Toolkit

A comprehensive toolkit for interacting with your **private** RPC endpoint at
`https://rpc.anoncenomics.com` (with Basic auth over TLS).

> **Auth**: Your Nginx is using **HTTP Basic**. Most server-side tools can send
> `Authorization: Basic …` headers. Browsers **cannot** set custom headers for
> WebSockets; use Node.js or server-to-server calls for WS connections, or
> remove Basic auth and rely on IP allowlisting/SSO if you need browser access.

## Endpoints
- **HTTP JSON-RPC**: `https://rpc.anoncenomics.com/`
- **WebSocket JSON-RPC**: `wss://rpc.anoncenomics.com/` (Node.js can send the auth header)

## Quick Start

### Option 1: Automated Setup (Recommended)
```bash
# Run the interactive setup script
./setup.sh
```

### Option 2: Manual Setup
```bash
# 1. Copy example and set credentials
cp .env.example .env

# 2. Edit .env with your credentials
nano .env  # or your preferred editor

# 3. Load environment variables
export $(cat .env | xargs)
```

### 3. Test Your Connection
```bash
# Test with curl (most reliable)
./curl-examples.sh test

# Test with Python
python python_example.py

# Test with Node.js (native fetch - works)
node node_polkadot_example.mjs
```

## Available Clients

### Bash/Curl Client (`curl-examples.sh`)
**Most reliable method** - works consistently with authentication.

```bash
# Basic commands
./curl-examples.sh health          # system_health
./curl-examples.sh version         # system_version
./curl-examples.sh chain           # system_chain
./curl-examples.sh head            # chain_getHeader
./curl-examples.sh hash [height]   # chain_getBlockHash
./curl-examples.sh block [height]  # chain_getBlock
./curl-examples.sh runtime         # state_getRuntimeVersion
./curl-examples.sh metadata        # state_getMetadata

# Run all tests
./curl-examples.sh test

# Custom RPC call
./curl-examples.sh call system_health
```

### Python Client (`python_example.py`)
**Requires**: `pip install requests`

```bash
# Run comprehensive tests
python python_example.py

# With custom environment
export RPC_URL=https://rpc.anoncenomics.com
export RPC_USER=anoncenomics
export RPC_PASS='password'
python python_example.py
```

### Node.js Client (`node_polkadot_example.mjs`)
**Note**: Uses native fetch for reliability (not @polkadot/api due to auth issues)

```bash
# Install dependencies
npm install

# Run tests
node node_polkadot_example.mjs

# With custom environment
export RPC_URL_HTTP=https://rpc.anoncenomics.com
export RPC_USER=anoncenomics
export RPC_PASS='password'
node node_polkadot_example.mjs
```

## Available RPC Methods

### System Methods
- `system_chain` - Get chain name
- `system_version` - Get node version
- `system_health` - Get node health status
- `system_localPeerId` - Get local peer ID

### Chain Methods
- `chain_getHeader` - Get latest block header
- `chain_getBlockHash` - Get block hash (optional: height)
- `chain_getBlock` - Get block by hash

### State Methods
- `state_getRuntimeVersion` - Get runtime version
- `state_getMetadata` - Get chain metadata

## Troubleshooting

### Authentication Issues
- **401 Unauthorized** → Check credentials in `.env` or environment variables
- **403 Forbidden** → Your IP may not be whitelisted

### DNS Issues
If your local resolver cached old Cloudflare answers:
```bash
# Force IP resolution
curl --resolve rpc.anoncenomics.com:443:91.98.21.193 ...

# Test authoritative NS
dig +short rpc.anoncenomics.com A @casey.ns.cloudflare.com
dig +short rpc.anoncenomics.com A @tani.ns.cloudflare.com
```

### Client-Specific Issues

#### Node.js @polkadot/api Issues
The `@polkadot/api` library has known authentication issues with this endpoint. The Node.js example uses native fetch as a workaround.

#### WebSocket Issues
WebSocket connections with auth headers require Node.js and may have similar auth issues.

### Local Server Check
On the server, test locally:
```bash
curl -s -H 'Content-Type: application/json' \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' \
  http://127.0.0.1:9944 | jq .
```

## Security Notes

> You started the node with **safe** RPC methods (no `--rpc-methods unsafe`), which
> is the recommended posture for a private endpoint behind TLS.

## Adding Office IPs
On the server:
```bash
# UFW (replace IP)
sudo ufw allow from 203.0.113.10 to any port 443 proto tcp comment 'RPC via TLS from office #N'

# Nginx allowlist
sudo sed -i 's/deny all;/allow 203.0.113.10;\n  deny all;/' /etc/nginx/sites-available/autonomys-rpc.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## Configuration

### Environment Variables
All clients use these environment variables:
- `RPC_URL` - RPC endpoint URL (default: `https://rpc.anoncenomics.com`)
- `RPC_URL_HTTP` - HTTP endpoint URL (defaults to `RPC_URL`)
- `RPC_URL_WS` - WebSocket endpoint URL (defaults to `RPC_URL` with `wss://`)
- `RPC_USER` - Authentication username (required)
- `RPC_PASS` - Authentication password (required)
- `RPC_TIMEOUT` - Request timeout in seconds (optional)
- `RPC_RETRIES` - Number of retry attempts (optional)

### Configuration Examples
See the `config-examples/` directory for:
- `.env.production` - Production environment template
- `.env.development` - Development environment template
- `docker-compose.yml` - Docker Compose deployment
- `Dockerfile` - Docker container setup
- `systemd.service` - Linux systemd service

## Files
- `.env.example` – Environment template
- `setup.sh` – Interactive setup script
- `curl-examples.sh` – Comprehensive bash/curl client
- `python_example.py` – Python client with full test suite
- `node_polkadot_example.mjs` – Node.js client (native fetch)
- `package.json` – Node.js dependencies
- `config-examples/` – Deployment configuration examples

