-- ULTIMATE CONSOLIDATION SCRIPT
-- Merge ALL scattered views into ONE comprehensive analytics view
-- Fix storage fee fund tracking
-- Create clean, maintainable structure

BEGIN;

-- ========================================
-- NUCLEAR CLEANUP: Remove ALL scattered views
-- ========================================

DROP MATERIALIZED VIEW IF EXISTS daily_metrics CASCADE;
DROP MATERIALIZED VIEW IF EXISTS epoch_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS financial_analytics CASCADE;
DROP MATERIALIZED VIEW IF EXISTS operator_details_enhanced CASCADE;
DROP MATERIALIZED VIEW IF EXISTS operator_performance CASCADE;
DROP MATERIALIZED VIEW IF EXISTS share_price_analytics CASCADE;
DROP MATERIALIZED VIEW IF EXISTS storage_fee_analytics CASCADE;
DROP MATERIALIZED VIEW IF EXISTS transaction_analytics CASCADE;
DROP MATERIALIZED VIEW IF EXISTS treasury_investigation CASCADE;
DROP VIEW IF EXISTS financial_display CASCADE;

-- ========================================
-- CREATE ONE COMPREHENSIVE ANALYTICS VIEW
-- ========================================

CREATE MATERIALIZED VIEW comprehensive_analytics AS
SELECT 
    epoch,
    end_block,
    timestamp,
    TO_TIMESTAMP(timestamp / 1000) as epoch_datetime,
    DATE(TO_TIMESTAMP(timestamp / 1000)) as epoch_date,
    
    -- ========================================
    -- FINANCIAL METRICS (full precision)
    -- ========================================
    
    -- Core stake and shares
    parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') as total_stake_raw,
    parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 1e18 as total_stake_tokens,
    
    COALESCE((data->>'totalShares')::NUMERIC, 0) as total_shares_raw,
    COALESCE((data->>'totalShares')::NUMERIC / 1e18, 0) as total_shares_tokens,
    
    -- Network share price (stake/shares ratio)
    CASE 
        WHEN COALESCE((data->>'totalShares')::NUMERIC, 0) > 0
        THEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 
             COALESCE((data->>'totalShares')::NUMERIC, 1)
        ELSE 1.0
    END as network_share_price,
    
    -- ========================================
    -- STORAGE FEE FUND (20% of deposits)
    -- ========================================
    
    -- Extract storage fees from operators (the 20% fund!)
    (SELECT SUM(
        hex_to_numeric(
            COALESCE((regexp_match(
                op_entry.value::TEXT, 
                '"totalStorageFeeDeposit":"(0x[a-fA-F0-9]+)"'
            ))[1], '0x0')
        )
    ) FROM jsonb_array_elements(data->'operators'->'entries') as op_entry
    WHERE op_entry.value::TEXT LIKE '%totalStorageFeeDeposit%'
    ) as storage_fee_fund_raw,
    
    (SELECT SUM(
        hex_to_numeric(
            COALESCE((regexp_match(
                op_entry.value::TEXT, 
                '"totalStorageFeeDeposit":"(0x[a-fA-F0-9]+)"'
            ))[1], '0x0')
        )
    ) FROM jsonb_array_elements(data->'operators'->'entries') as op_entry
    WHERE op_entry.value::TEXT LIKE '%totalStorageFeeDeposit%'
    ) / 1e18 as storage_fee_fund_tokens,
    
    -- ========================================
    -- OPERATOR METRICS (consolidated)
    -- ========================================
    
    COALESCE((data->'operators'->>'count')::INTEGER, 0) as operator_count,
    
    -- Operator 0 data
    COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) / 1e18, 0) as operator_0_stake_tokens,
    COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentEpochRewards'->>'0')::TEXT) / 1e18, 0) as operator_0_rewards_tokens,
    
    -- Operator 1 data  
    COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) / 1e18, 0) as operator_1_stake_tokens,
    COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentEpochRewards'->>'1')::TEXT) / 1e18, 0) as operator_1_rewards_tokens,
    
    -- Market share calculations
    CASE 
        WHEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') > 0
        THEN parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) * 100.0 / 
             parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')
        ELSE 0
    END as operator_0_market_share,
    
    CASE 
        WHEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') > 0
        THEN parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) * 100.0 / 
             parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')
        ELSE 0
    END as operator_1_market_share,
    
    -- ========================================
    -- TRANSACTION METRICS
    -- ========================================
    
    COALESCE((data->'deposits'->>'count')::INTEGER, 0) as deposits_count,
    COALESCE((data->'withdrawals'->>'count')::INTEGER, 0) as withdrawals_count,
    COALESCE((data->'successfulBundles'->>'count')::INTEGER, 0) as bundles_count,
    
    COALESCE((data->'deposits'->>'count')::INTEGER, 0) + 
    COALESCE((data->'withdrawals'->>'count')::INTEGER, 0) as transaction_volume,
    
    -- ========================================
    -- GROWTH ANALYSIS
    -- ========================================
    
    -- Stake growth
    parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') - 
    LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch) as stake_change_raw,
    
    CASE 
        WHEN LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch) > 0
        THEN ((parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') - 
             LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch)) * 100.0 / 
             LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch))
        ELSE 0.0
    END as stake_growth_percentage,
    
    -- Moving averages
    AVG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (
        ORDER BY epoch ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) / 1e18 as stake_7epoch_ma,
    
    created_at
FROM epochs
ORDER BY epoch;

-- ========================================
-- CREATE ESSENTIAL INDEXES ONLY
-- ========================================

CREATE INDEX idx_comprehensive_datetime ON comprehensive_analytics(epoch_datetime);
CREATE INDEX idx_comprehensive_date ON comprehensive_analytics(epoch_date);
CREATE INDEX idx_comprehensive_stake ON comprehensive_analytics(total_stake_tokens);

-- ========================================
-- REFRESH AND FINAL VALIDATION
-- ========================================

REFRESH MATERIALIZED VIEW comprehensive_analytics;

COMMIT;

-- ========================================
-- FINAL CONSOLIDATED RESULTS
-- ========================================

\echo ''
\echo '=== CONSOLIDATION COMPLETE ==='

-- Show the single comprehensive view
SELECT 
    COUNT(*) as total_epochs,
    COUNT(CASE WHEN storage_fee_fund_tokens > 0 THEN 1 END) as epochs_with_storage_fees,
    ROUND(AVG(CASE WHEN storage_fee_fund_tokens > 0 AND total_stake_tokens > 0 
              THEN storage_fee_fund_tokens / total_stake_tokens * 100 END), 2) as avg_storage_fee_percentage,
    MAX(total_stake_tokens) as max_stake_tokens,
    MAX(storage_fee_fund_tokens) as max_storage_fund_tokens
FROM comprehensive_analytics;

-- Test storage fee fund discovery
\echo ''
\echo '=== STORAGE FEE FUND VALIDATION ==='
SELECT 
    epoch,
    total_stake_tokens,
    storage_fee_fund_tokens,
    ROUND(storage_fee_fund_tokens / total_stake_tokens * 100, 2) as storage_percentage
FROM comprehensive_analytics
WHERE epoch IN (2621, 2635, 2645)
AND storage_fee_fund_tokens > 0
ORDER BY epoch;
