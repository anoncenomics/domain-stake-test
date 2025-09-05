# Domain Stake Database Migration Strategy

## **Recommended Approach: Hybrid Schema Design**

### **Option 1: Primary JSONB Table** (Recommended for data preservation)
```sql
-- Main epochs table preserving full JSON structure
CREATE TABLE epochs (
    epoch BIGINT PRIMARY KEY,
    end_block BIGINT NOT NULL,
    end_hash TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    data JSONB NOT NULL,  -- Full JSON data with PostgreSQL JSONB optimization
    created_at TIMESTAMP DEFAULT NOW()
);

-- Optimized indexes for common queries
CREATE INDEX idx_epochs_timestamp ON epochs(timestamp);
CREATE INDEX idx_epochs_end_block ON epochs(end_block);

-- JSONB indexes for efficient nested queries
CREATE INDEX idx_epochs_total_stake ON epochs USING GIN ((data->'totalStake'));
CREATE INDEX idx_epochs_operators ON epochs USING GIN ((data->'operators'));
CREATE INDEX idx_epochs_deposits ON epochs USING GIN ((data->'deposits'));
```

### **Option 2: Normalized Views** (For query optimization)
```sql
-- Create materialized views for frequently accessed data
CREATE MATERIALIZED VIEW epoch_summary AS
SELECT 
    epoch,
    end_block,
    end_hash,
    timestamp,
    (data->>'totalStake')::TEXT as total_stake,
    (data->>'totalShares')::TEXT as total_shares,
    (data->>'accumulatedTreasuryFunds')::TEXT as treasury_funds,
    (data->'operators'->>'count')::INTEGER as operator_count,
    (data->'deposits'->>'count')::INTEGER as deposits_count,
    (data->'withdrawals'->>'count')::INTEGER as withdrawals_count
FROM epochs;

-- Operator details view
CREATE MATERIALIZED VIEW epoch_operators AS
SELECT 
    e.epoch,
    e.timestamp,
    op.key[1] as operator_id,
    op.value as operator_data
FROM epochs e,
LATERAL jsonb_each(e.data->'operators'->'entries') as op(key, value);
```

## **Migration Process**

### **Step 1: SQLite to PostgreSQL Conversion**
```bash
# Convert SQLite SQL to PostgreSQL-compatible format
# Handle data type differences and syntax changes
```

### **Step 2: Schema Creation**
```sql
-- Create tables with proper constraints
-- Set up indexes and materialized views
-- Configure Row Level Security if needed
```

### **Step 3: Data Import**
```bash
# Use PostgreSQL COPY command for bulk import
# Validate data integrity
# Refresh materialized views
```

## **Advantages of This Approach**

### **Data Preservation**
- ✅ Zero data loss - complete JSON structure preserved
- ✅ Future-proof - can extract new metrics as blockchain evolves
- ✅ Maintains data relationships and nested structures

### **Query Flexibility**
- ✅ JSONB provides efficient JSON operations
- ✅ Can query nested data with PostgreSQL JSON operators
- ✅ Materialized views provide fast access to common queries

### **Performance Optimization**
- ✅ GIN indexes on JSONB for fast nested queries
- ✅ Materialized views for aggregated data
- ✅ Can add more views as query patterns emerge

## **Trade-offs Consideration**

### **Pros:**
1. **Complete Data Preservation**: No loss of complex nested structures
2. **Query Flexibility**: Can access any part of the JSON data
3. **Evolution Ready**: Easy to add new query patterns without schema changes
4. **PostgreSQL Optimized**: JSONB provides better performance than plain JSON

### **Cons:**
1. **Storage Overhead**: JSONB uses more storage than normalized tables
2. **Complex Queries**: Some queries may be more complex than with normalized schema
3. **Learning Curve**: Team needs to understand JSONB query syntax

## **Alternative: Full Normalization**

If storage and query performance are critical, we could normalize into:
- `epochs` (basic info)
- `epoch_operators` 
- `epoch_deposits`
- `epoch_withdrawals`
- `epoch_execution_receipts`
- etc.

**However, this risks data loss and reduces flexibility for blockchain data.**
