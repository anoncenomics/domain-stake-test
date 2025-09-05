#!/bin/bash

# Supabase Import Script for Domain Stake Database
# This script handles the complete import process

set -e  # Exit on any error

# Configuration
BACKUP_FILE="rpc-toolkit/backup/comprehensive-metrics-full_20250827T073704Z.sql"
POSTGRES_FILE="domain_stake_postgres.sql"
LOG_FILE="import_$(date +%Y%m%d_%H%M%S).log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
    exit 1
}

warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_FILE"
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if backup file exists
    if [ ! -f "$BACKUP_FILE" ]; then
        error "Backup file not found: $BACKUP_FILE"
    fi
    
    # Check if Python is available
    if ! command -v python3 &> /dev/null; then
        error "Python3 is required but not installed"
    fi
    
    # Check if psql is available (for Supabase import)
    if ! command -v psql &> /dev/null; then
        warn "psql not found. You'll need to install PostgreSQL client for direct import"
    fi
    
    success "Prerequisites check completed"
}

# Convert SQLite to PostgreSQL
convert_database() {
    log "Converting SQLite backup to PostgreSQL format..."
    
    python3 sqlite_to_postgres_converter.py "$BACKUP_FILE" "$POSTGRES_FILE"
    
    if [ ! -f "$POSTGRES_FILE" ]; then
        error "Conversion failed - PostgreSQL file not created"
    fi
    
    success "Database conversion completed: $POSTGRES_FILE"
}

# Validate the converted file
validate_conversion() {
    log "Validating converted PostgreSQL file..."
    
    # Check file size
    original_size=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE")
    converted_size=$(stat -f%z "$POSTGRES_FILE" 2>/dev/null || stat -c%s "$POSTGRES_FILE")
    
    log "Original file size: $(($original_size / 1024 / 1024)) MB"
    log "Converted file size: $(($converted_size / 1024 / 1024)) MB"
    
    # Basic syntax check
    if grep -q "BEGIN;" "$POSTGRES_FILE" && grep -q "COMMIT;" "$POSTGRES_FILE"; then
        success "PostgreSQL file structure looks valid"
    else
        warn "PostgreSQL file may have structural issues"
    fi
    
    # Count INSERT statements
    insert_count=$(grep -c "INSERT INTO epochs" "$POSTGRES_FILE" || echo "0")
    log "Found $insert_count INSERT statements"
    
    if [ "$insert_count" -gt 0 ]; then
        success "Validation completed - ready for import"
    else
        error "No INSERT statements found - conversion may have failed"
    fi
}

# Import to Supabase
import_to_supabase() {
    log "Preparing Supabase import instructions..."
    
    echo ""
    echo "========================================="
    echo "SUPABASE IMPORT INSTRUCTIONS"
    echo "========================================="
    echo ""
    echo "1. Get your Supabase connection details from your dashboard:"
    echo "   - Host: [your-project].pooler.supabase.com"
    echo "   - Port: 6543"
    echo "   - Database: postgres"
    echo "   - Username: postgres.[your-project]"
    echo "   - Password: [your-database-password]"
    echo ""
    echo "2. Import using psql command:"
    echo "   psql -h [HOST] -p 6543 -d postgres -U postgres.[PROJECT] -f $POSTGRES_FILE"
    echo ""
    echo "3. Or using Supabase CLI (if installed):"
    echo "   supabase db reset --linked"
    echo "   psql \"\$DATABASE_URL\" -f $POSTGRES_FILE"
    echo ""
    echo "4. Alternative: Copy the SQL content and paste into Supabase SQL Editor"
    echo ""
    echo "========================================="
    echo ""
    
    # Offer to split large file if needed
    file_size_mb=$(($converted_size / 1024 / 1024))
    if [ "$file_size_mb" -gt 100 ]; then
        warn "File is large (${file_size_mb}MB). Consider splitting for easier import."
        echo ""
        echo "To split the file into smaller chunks:"
        echo "  split -l 1000 $POSTGRES_FILE ${POSTGRES_FILE%.sql}_part_"
        echo ""
    fi
}

# Create import validation script
create_validation_script() {
    log "Creating post-import validation script..."
    
    cat > validate_import.sql << 'EOF'
-- Post-import validation queries
-- Run these after importing to Supabase

-- Check record count
SELECT COUNT(*) as total_epochs FROM epochs;

-- Check data range
SELECT 
    MIN(epoch) as min_epoch,
    MAX(epoch) as max_epoch,
    MIN(timestamp) as min_timestamp,
    MAX(timestamp) as max_timestamp
FROM epochs;

-- Check JSON data integrity
SELECT 
    COUNT(*) as total_records,
    COUNT(CASE WHEN data ? 'totalStake' THEN 1 END) as records_with_total_stake,
    COUNT(CASE WHEN data ? 'operators' THEN 1 END) as records_with_operators
FROM epochs;

-- Sample query using JSONB
SELECT 
    epoch,
    data->>'totalStake' as total_stake,
    data->'operators'->>'count' as operator_count
FROM epochs 
ORDER BY epoch DESC 
LIMIT 10;

-- Check materialized view
SELECT COUNT(*) as summary_count FROM epoch_summary;

-- Performance test
EXPLAIN ANALYZE 
SELECT * FROM epochs WHERE data->>'totalStake' IS NOT NULL LIMIT 100;
EOF

    success "Validation script created: validate_import.sql"
}

# Main execution
main() {
    log "Starting Domain Stake Database migration to Supabase"
    log "Log file: $LOG_FILE"
    
    check_prerequisites
    convert_database
    validate_conversion
    create_validation_script
    import_to_supabase
    
    success "Migration preparation completed!"
    echo ""
    echo "Files created:"
    echo "  - $POSTGRES_FILE (PostgreSQL import file)"
    echo "  - validate_import.sql (Post-import validation)"
    echo "  - $LOG_FILE (Process log)"
    echo ""
    echo "Ready for Supabase import!"
}

# Run main function
main "$@"
