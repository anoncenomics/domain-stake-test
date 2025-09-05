#!/usr/bin/env python3
"""
Python RPC client for Autonomys/Subspace
Requires: pip install requests
"""

import os, json, base64, sys
import requests

RPC_URL = os.getenv("RPC_URL", "https://rpc.anoncenomics.com")
RPC_USER = os.getenv("RPC_USER", "")
RPC_PASS = os.getenv("RPC_PASS", "")

# Validate required environment variables
if not RPC_USER or not RPC_PASS:
    print("❌ Error: RPC_USER and RPC_PASS environment variables are required")
    print("Please set them in your .env file or environment:")
    print("  export RPC_USER=your_username")
    print("  export RPC_PASS=your_password")
    sys.exit(1)

AUTH = base64.b64encode(f"{RPC_USER}:{RPC_PASS}".encode()).decode()

def rpc(method, params=None):
    """Make JSON-RPC call to the endpoint"""
    payload = {"jsonrpc":"2.0","id":1,"method":method,"params":params or []}
    r = requests.post(RPC_URL, json=payload, headers={
        "Authorization": f"Basic {AUTH}",
        "Content-Type": "application/json"
    }, timeout=60)
    r.raise_for_status()
    return r.json()

def test_basic_methods():
    """Test basic RPC methods"""
    print("=== Basic RPC Methods ===")
    print(f"RPC_URL: {RPC_URL}")
    print(f"User: {RPC_USER}")
    
    try:
        chain = rpc("system_chain")
        print(f"system_chain: {chain}")
        
        version = rpc("system_version")
        print(f"system_version: {version}")
        
        health = rpc("system_health")
        print(f"system_health: {json.dumps(health, indent=2)}")
        
        header = rpc("chain_getHeader")
        print(f"chain_getHeader: {json.dumps(header, indent=2)}")
        
        return True
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_chain_methods():
    """Test chain-related methods"""
    print("\n=== Chain Methods ===")
    try:
        # Get latest block hash
        latest_hash = rpc("chain_getBlockHash")
        print(f"Latest block hash: {latest_hash}")
        
        # Get block by hash
        if latest_hash.get('result'):
            block = rpc("chain_getBlock", [latest_hash['result']])
            print(f"Latest block: {json.dumps(block, indent=2)}")
        
        # Get block hash at height 1000
        hash_1000 = rpc("chain_getBlockHash", [1000])
        print(f"Block hash at height 1000: {hash_1000}")
        
        return True
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_state_methods():
    """Test state-related methods"""
    print("\n=== State Methods ===")
    try:
        # Get runtime version
        runtime = rpc("state_getRuntimeVersion")
        print(f"Runtime version: {json.dumps(runtime, indent=2)}")
        
        # Get metadata
        metadata = rpc("state_getMetadata")
        print(f"Metadata (truncated): {str(metadata)[:200]}...")
        
        return True
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    print("Autonomys/Subspace RPC Client (Python)")
    print("=" * 50)
    
    success = True
    success &= test_basic_methods()
    success &= test_chain_methods()
    success &= test_state_methods()
    
    if success:
        print("\n✅ All tests passed!")
    else:
        print("\n❌ Some tests failed")
        sys.exit(1)
