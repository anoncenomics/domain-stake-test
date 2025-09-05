
#!/usr/bin/env bash
# Comprehensive RPC client for Autonomys/Subspace
# Requires: jq, curl

set -euo pipefail

# Load .env if present
if [ -f .env ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | xargs -I {} echo {})
fi

RPC_URL="${RPC_URL:-https://rpc.anoncenomics.com}"
RPC_USER="${RPC_USER:-}"
RPC_PASS="${RPC_PASS:-}"

# Validate required environment variables
if [[ -z "$RPC_USER" || -z "$RPC_PASS" ]]; then
  echo "❌ Error: RPC_USER and RPC_PASS environment variables are required"
  echo "Please set them in your .env file or environment:"
  echo "  export RPC_USER=your_username"
  echo "  export RPC_PASS=your_password"
  exit 1
fi

# Compute Basic auth (portable: no wrapping)
AUTH="$(printf '%s:%s' "$RPC_USER" "$RPC_PASS" | base64 | tr -d '\n')"

rpc() {
  local method="$1"; shift
  local params="${*:-[]}"

  curl -sS -H "Authorization: Basic ${AUTH}" \
       -H 'Content-Type: application/json' \
       --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
       "${RPC_URL}" | jq .
}

echo "Autonomys/Subspace RPC Client (Bash/Curl)"
echo "=========================================="
echo "RPC_URL=${RPC_URL}"
echo "User: ${RPC_USER}"
echo

# Show available commands
show_help() {
  echo "Available commands:"
  echo "  ./curl-examples.sh health          # system_health"
  echo "  ./curl-examples.sh version         # system_version"
  echo "  ./curl-examples.sh chain           # system_chain"
  echo "  ./curl-examples.sh head            # chain_getHeader"
  echo "  ./curl-examples.sh hash [height]   # chain_getBlockHash"
  echo "  ./curl-examples.sh block [height]  # chain_getBlock"
  echo "  ./curl-examples.sh runtime         # state_getRuntimeVersion"
  echo "  ./curl-examples.sh metadata        # state_getMetadata"
  echo "  ./curl-examples.sh test            # Run all basic tests"
  echo "  ./curl-examples.sh call <method> <params>  # Custom RPC call"
}

# Test all basic methods
run_tests() {
  echo "Running comprehensive tests..."
  echo
  
  echo "=== Basic System Methods ==="
  rpc system_chain
  rpc system_version
  rpc system_health
  
  echo -e "\n=== Chain Methods ==="
  rpc chain_getHeader
  rpc chain_getBlockHash
  
  echo -e "\n=== State Methods ==="
  rpc state_getRuntimeVersion
  
  echo -e "\n✅ All tests completed!"
}

case "${1:-}" in
  health) rpc system_health ;;
  version) rpc system_version ;;
  chain) rpc system_chain ;;
  head) rpc chain_getHeader ;;
  hash) rpc chain_getBlockHash "${2:-}" ;;
  runtime) rpc state_getRuntimeVersion ;;
  metadata) rpc state_getMetadata ;;
  block)
    if [[ -n "${2:-}" ]]; then
      # Lookup hash then fetch block
      H=$(curl -sS -H "Authorization: Basic ${AUTH}" -H 'Content-Type: application/json' \
         --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"chain_getBlockHash\",\"params\":[${2}]}" \
         "${RPC_URL}" | jq -r .result)
      rpc chain_getBlock "[\"$H\"]"
    else
      rpc chain_getBlock
    fi
    ;;
  test) run_tests ;;
  call) rpc "${2}" "${3:-[]}" ;;
  help|--help|-h) show_help ;;
  *)
    show_help
    echo
    echo "Example: ./curl-examples.sh health"
    ;;
esac
