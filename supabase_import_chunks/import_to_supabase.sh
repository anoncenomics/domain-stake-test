#!/bin/bash

# Supabase Import Script - Auto-generated
# Import Domain Stake Database in correct order

set -e  # Exit on any error

# Supabase connection details
DB_HOST="db.kaxlpwjlesmlfiawsfvy.supabase.co"
DB_PORT="5432"
DB_NAME="postgres"
DB_USER="postgres"
DB_PASS="dl33D#YWGmrm0EKD%Lk7t$"

# Alternative pooler connection (use if direct connection fails)
POOLER_HOST="aws-1-us-east-1.pooler.supabase.com"
POOLER_PORT="6543"
POOLER_USER="postgres.kaxlpwjlesmlfiawsfvy"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Try direct connection first, fallback to pooler
try_import() {
    local file="$1"
    local attempt="$2"
    
    if [ "$attempt" = "direct" ]; then
        PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" -U "$DB_USER" -f "$file"
    else
        PGPASSWORD="$DB_PASS" psql -h "$POOLER_HOST" -p "$POOLER_PORT" -d "$DB_NAME" -U "$POOLER_USER" -f "$file"
    fi
}

import_file() {
    local file="$1"
    log "Importing $file..."
    
    if try_import "$file" "direct" 2>/dev/null; then
        success "Successfully imported $file (direct connection)"
    elif try_import "$file" "pooler" 2>/dev/null; then
        success "Successfully imported $file (pooler connection)"
    else
        error "Failed to import $file with both connection methods"
    fi
    
    # Brief pause between imports
    sleep 2
}

main() {
    log "Starting Supabase import process..."
    log "Total files to import: 8"
    
    # Check if psql is available
    if ! command -v psql &> /dev/null; then
        error "psql is not installed. Please install PostgreSQL client."
    fi
    
    log "Step 1/8: Importing 01_schema.sql..."
    import_file "01_schema.sql"
    
    log "Step 2/8: Importing 02_data_chunk_01.sql..."
    import_file "02_data_chunk_01.sql"
    
    log "Step 3/8: Importing 02_data_chunk_02.sql..."
    import_file "02_data_chunk_02.sql"
    
    log "Step 4/8: Importing 02_data_chunk_03.sql..."
    import_file "02_data_chunk_03.sql"
    
    log "Step 5/8: Importing 02_data_chunk_04.sql..."
    import_file "02_data_chunk_04.sql"
    
    log "Step 6/8: Importing 02_data_chunk_05.sql..."
    import_file "02_data_chunk_05.sql"
    
    log "Step 7/8: Importing 02_data_chunk_06.sql..."
    import_file "02_data_chunk_06.sql"
    
    log "Step 8/8: Importing 03_indexes.sql..."
    import_file "03_indexes.sql"
    
    
    success "All files imported successfully!"
    log "Running post-import validation..."
    
    # Run validation queries
    echo "SELECT COUNT(*) as total_epochs FROM epochs;" | try_import /dev/stdin direct || try_import /dev/stdin pooler
    
    success "Import process completed!"
    echo ""
    echo "Next steps:"
    echo "1. Run the validation queries in validate_import.sql"
    echo "2. Test your application queries"
    echo "3. Set up Row Level Security if needed"
}

main "$@"
