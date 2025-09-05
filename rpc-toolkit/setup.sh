#!/usr/bin/env bash
# Setup script for Autonomys/Subspace RPC Toolkit

set -euo pipefail

echo "🚀 Autonomys/Subspace RPC Toolkit Setup"
echo "========================================"

# Check if .env already exists
if [[ -f .env ]]; then
    echo "⚠️  .env file already exists. Do you want to overwrite it? (y/N)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Setup cancelled."
        exit 0
    fi
fi

# Copy .env.example to .env
echo "📝 Creating .env file from template..."
cp .env.example .env

echo ""
echo "🔧 Configuration Required"
echo "Please edit the .env file with your credentials:"
echo "  nano .env"
echo ""
echo "Required variables:"
echo "  RPC_USER=your_username"
echo "  RPC_PASS=your_password"
echo ""

# Check if user wants to configure now
echo "Would you like to configure the credentials now? (y/N)"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    echo ""
    echo "Enter your RPC username:"
    read -r rpc_user
    echo "Enter your RPC password:"
    read -s rpc_pass
    echo ""
    
    # Update .env file
    sed -i "s/RPC_USER=.*/RPC_USER=$rpc_user/" .env
    sed -i "s/RPC_PASS=.*/RPC_PASS=$rpc_pass/" .env
    
    echo "✅ Credentials updated in .env file"
fi

# Load environment variables
echo ""
echo "📋 Loading environment variables..."
export $(grep -v '^#' .env | xargs)

# Test connection
echo ""
echo "🧪 Testing connection..."
if ./curl-examples.sh health > /dev/null 2>&1; then
    echo "✅ Connection successful!"
else
    echo "❌ Connection failed. Please check your credentials and network."
    exit 1
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Test with: ./curl-examples.sh test"
echo "  2. Run Python client: python python_example.py"
echo "  3. Run Node.js client: node node_polkadot_example.mjs"
echo ""
echo "For more examples, see config-examples/ directory"
