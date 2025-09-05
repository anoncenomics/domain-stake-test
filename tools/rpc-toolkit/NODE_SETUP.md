# Using Your Autonomys RPC Node

This guide explains how to use your authenticated Autonomys RPC endpoint at `https://rpc.anoncenomics.com` with the backfill script.

## Prerequisites

1. **Autonomys RPC Access**: You need credentials for the Autonomys RPC endpoint
2. **Node.js**: Make sure you have Node.js installed
3. **Dependencies**: Install the required packages with `npm install`

## Default Configuration

The script now defaults to using your authenticated Autonomys RPC endpoint at `wss://rpc.anoncenomics.com`.

## Setup Authentication

### Method 1: Environment Variables (Recommended)

```bash
# Set your credentials
export RPC_USER=your_username
export RPC_PASS=your_password

# Test connection
node test-node-connection.mjs

# Run backfill script
node backfill-epochs-with-storage-fees.mjs --domain 0
```

### Method 2: .env File

```bash
# Copy example and edit with your credentials
cp .env.example .env
nano .env  # or your preferred editor

# Load environment variables
export $(cat .env | xargs)

# Test connection
node test-node-connection.mjs

# Run backfill script
node backfill-epochs-with-storage-fees.mjs --domain 0
```

### Method 3: Command Line Arguments

```bash
# Test connection
node test-node-connection.mjs --user your_username --pass your_password

# Run backfill script
node backfill-epochs-with-storage-fees.mjs --user your_username --pass your_password --domain 0
```

## Testing Your Connection

Before running the main script, test your connection:

```bash
# Test with environment variables
export RPC_USER=your_username
export RPC_PASS=your_password
node test-node-connection.mjs

# Test with .env file
export $(cat .env | xargs)
node test-node-connection.mjs

# Test with command line
node test-node-connection.mjs --user your_username --pass your_password
```

## Running the Backfill Script

### Using Environment Variables (Recommended)

```bash
# Set credentials
export RPC_USER=your_username
export RPC_PASS=your_password

# Run backfill
node backfill-epochs-with-storage-fees.mjs --domain 0 --from 100 --to 200

# With custom output
node backfill-epochs-with-storage-fees.mjs --domain 0 --out ./my-data.json
```

### Using .env File

```bash
# Load credentials from .env
export $(cat .env | xargs)

# Run backfill
node backfill-epochs-with-storage-fees.mjs --domain 0
```

### Using Command Line Arguments

```bash
# Run with inline credentials
node backfill-epochs-with-storage-fees.mjs --user your_username --pass your_password --domain 0
```

## Using Different Nodes

If you want to use a different node (e.g., local node or public RPC):

```bash
# Use local node
node backfill-epochs-with-storage-fees.mjs --ws wss://localhost:9944 --domain 0

# Use public RPC (not recommended for heavy queries)
node backfill-epochs-with-storage-fees.mjs --ws wss://rpc.mainnet.subspace.foundation/ws --domain 0
```

## Troubleshooting

### Authentication Issues

1. **Check credentials**:
   ```bash
   echo "Username: $RPC_USER"
   echo "Password: $RPC_PASS"
   ```

2. **Test with curl** (most reliable):
   ```bash
   ./curl-examples.sh test
   ```

3. **Test with the test script**:
   ```bash
   node test-node-connection.mjs --user your_username --pass your_password
   ```

### Connection Issues

1. **Check if endpoint is accessible**:
   ```bash
   curl -I https://rpc.anoncenomics.com
   ```

2. **Test WebSocket connection**:
   ```bash
   node test-node-connection.mjs
   ```

### Performance Tips

1. **Use your Autonomys node**: It's optimized for your use case
2. **Monitor resource usage**: The script makes many queries
3. **Use appropriate epoch ranges**: Don't query too many epochs at once
4. **Check node performance**: Ensure your node can handle the load

## Script Options

Run `node backfill-epochs-with-storage-fees.mjs --help` to see all available options:

- `--ws <url>`: WebSocket RPC endpoint
- `--user <username>`: RPC username for authentication
- `--pass <password>`: RPC password for authentication
- `--domain <id>`: Domain ID to query
- `--from <epoch>`: Starting epoch number
- `--to <epoch>`: Ending epoch number or 'current'
- `--out <path>`: Output file path
- `--append`: Append to existing output file
- `--help`: Show help message

## Environment Variables

You can use environment variables instead of command-line arguments:

- `RPC_URL_WS`: WebSocket RPC endpoint
- `RPC_USER`: RPC username
- `RPC_PASS`: RPC password
- `DOMAIN`: Domain ID
- `FROM`: Starting epoch
- `TO`: Ending epoch
- `OUT`: Output file path

## Security Notes

- **Never commit credentials**: Keep your `.env` file in `.gitignore`
- **Use environment variables**: More secure than command line arguments
- **Rotate credentials**: Change passwords periodically
- **Monitor usage**: Check for unusual activity on your RPC endpoint
