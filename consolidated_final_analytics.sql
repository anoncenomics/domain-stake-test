-- CONSOLIDATED FINAL ANALYTICS
-- ONE comprehensive view with all financial metrics
-- Fix storage fee calculation (20% of deposits, not trending)
-- Merge all scattered views into single source of truth

BEGIN;

-- ========================================
-- CLEAN SLATE: Remove all scattered views
-- ========================================

DROP MATERIALIZED VIEW IF EXISTS financial_analytics_enhanced CASCADE;
DROP MATERIALIZED VIEW IF EXISTS storage_fee_analytics CASCADE;
DROP MATERIALIZED VIEW IF EXISTS share_price_analytics CASCADE;
DROP VIEW IF EXISTS financial_display CASCADE;
DROP MATERIALIZED VIEW IF EXISTS financial_analytics CASCADE;

-- ========================================
-- SINGLE COMPREHENSIVE FINANCIAL ANALYTICS VIEW
-- ========================================

CREATE MATERIALIZED VIEW financial_analytics AS
SELECT 
    epoch,
    end_block,
    timestamp,
    TO_TIMESTAMP(timestamp / 1000) as epoch_datetime,
    DATE(TO_TIMESTAMP(timestamp / 1000)) as epoch_date,
    EXTRACT(HOUR FROM TO_TIMESTAMP(timestamp / 1000)) as epoch_hour,
    
    -- ========================================
    -- CORE FINANCIAL METRICS (raw precision)
    -- ========================================
    
    -- Stake and Shares (raw and token values)
    parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') as total_stake_raw,
    parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 1e18 as total_stake_tokens,
    
    COALESCE((data->>'totalShares')::NUMERIC, 0) as total_shares_raw,
    COALESCE((data->>'totalShares')::NUMERIC / 1e18, 0) as total_shares_tokens,
    
    -- Network Share Price (stake/shares ratio)
    CASE 
        WHEN COALESCE((data->>'totalShares')::NUMERIC, 0) > 0
        THEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 
             COALESCE((data->>'totalShares')::NUMERIC, 1)
        ELSE 1.0
    END as network_share_price_ratio,
    
    -- Treasury and Rewards
    COALESCE((data->>'accumulatedTreasuryFunds')::NUMERIC, 0) as treasury_funds_raw,
    COALESCE((data->>'accumulatedTreasuryFunds')::NUMERIC / 1e18, 0) as treasury_funds_tokens,
    
    COALESCE((data->>'domainChainRewards')::NUMERIC, 0) as chain_rewards_raw,
    COALESCE((data->>'domainChainRewards')::NUMERIC / 1e18, 0) as chain_rewards_tokens,
    
    -- ========================================
    -- STORAGE FEE FUND (20% of deposits - fixed calculation)
    -- ========================================
    
    -- Extract total storage fees from all operators
    (SELECT SUM(
        hex_to_numeric((regexp_match(
            op_entry.value::TEXT, 
            '"totalStorageFeeDeposit":"(0x[a-fA-F0-9]+)"'
        ))[1])
    ) FROM jsonb_array_elements(data->'operators'->'entries') as op_entry
    WHERE op_entry.value::TEXT LIKE '%totalStorageFeeDeposit%'
    ) as storage_fee_fund_raw,
    
    (SELECT SUM(
        hex_to_numeric((regexp_match(
            op_entry.value::TEXT, 
            '"totalStorageFeeDeposit":"(0x[a-fA-F0-9]+)"'
        ))[1])
    ) FROM jsonb_array_elements(data->'operators'->'entries') as op_entry
    WHERE op_entry.value::TEXT LIKE '%totalStorageFeeDeposit%'
    ) / 1e18 as storage_fee_fund_tokens,
    
    -- Storage fee as percentage of total stake (should be ~20-25%)
    CASE 
        WHEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') > 0
        THEN (SELECT SUM(
            hex_to_numeric((regexp_match(
                op_entry.value::TEXT, 
                '"totalStorageFeeDeposit":"(0x[a-fA-F0-9]+)"'
            ))[1])
        ) FROM jsonb_array_elements(data->'operators'->'entries') as op_entry
        WHERE op_entry.value::TEXT LIKE '%totalStorageFeeDeposit%'
        ) * 100.0 / parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')
        ELSE 0
    END as storage_fee_percentage,
    
    -- ========================================
    -- GROWTH AND TREND ANALYSIS
    -- ========================================
    
    -- Stake growth tracking
    parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') - 
    LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch) as stake_change_raw,
    
    CASE 
        WHEN LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch) > 0
        THEN ((parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') - 
             LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch)) * 100.0 / 
             LAG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (ORDER BY epoch))
        ELSE 0.0
    END as stake_growth_percentage,
    
    -- Share price change tracking
    CASE 
        WHEN COALESCE((data->>'totalShares')::NUMERIC, 0) > 0
        THEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 
             COALESCE((data->>'totalShares')::NUMERIC, 1)
        ELSE 1.0
    END - 
    LAG(CASE 
        WHEN COALESCE((data->>'totalShares')::NUMERIC, 0) > 0
        THEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 
             COALESCE((data->>'totalShares')::NUMERIC, 1)
        ELSE 1.0
    END) OVER (ORDER BY epoch) as share_price_change,
    
    -- Moving averages for trend analysis
    AVG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (
        ORDER BY epoch ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) / 1e18 as stake_7epoch_ma_tokens,
    
    AVG(parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')) OVER (
        ORDER BY epoch ROWS BETWEEN 19 PRECEDING AND CURRENT ROW  
    ) / 1e18 as stake_20epoch_ma_tokens,
    
    -- ========================================
    -- ACTIVITY AND OPERATIONAL METRICS
    -- ========================================
    
    COALESCE((data->'operators'->>'count')::INTEGER, 0) as operator_count,
    COALESCE((data->'deposits'->>'count')::INTEGER, 0) as deposits_count,
    COALESCE((data->'withdrawals'->>'count')::INTEGER, 0) as withdrawals_count,
    COALESCE((data->'successfulBundles'->>'count')::INTEGER, 0) as successful_bundles_count,
    
    -- Total transaction volume
    COALESCE((data->'deposits'->>'count')::INTEGER, 0) + 
    COALESCE((data->'withdrawals'->>'count')::INTEGER, 0) as total_transaction_volume,
    
    created_at
FROM epochs
ORDER BY epoch;

-- ========================================
-- ESSENTIAL INDEXES (consolidated)
-- ========================================

CREATE INDEX idx_financial_epoch_datetime ON financial_analytics(epoch_datetime);
CREATE INDEX idx_financial_date ON financial_analytics(epoch_date);
CREATE INDEX idx_financial_stake_tokens ON financial_analytics(total_stake_tokens);
CREATE INDEX idx_financial_storage_fund ON financial_analytics(storage_fee_fund_tokens);
CREATE INDEX idx_financial_share_price ON financial_analytics(network_share_price_ratio);

-- ========================================
-- REFRESH AND VALIDATE
-- ========================================

REFRESH MATERIALIZED VIEW financial_analytics;

-- Test the consolidated view
SELECT 
    '🎉 CONSOLIDATED ANALYTICS COMPLETE' as status;

SELECT 
    epoch,
    total_stake_tokens,
    storage_fee_fund_tokens,
    ROUND(storage_fee_percentage, 2) as storage_fee_percent,
    network_share_price_ratio,
    stake_growth_percentage,
    operator_count
FROM financial_analytics
WHERE epoch BETWEEN 2620 AND 2625
AND storage_fee_fund_tokens > 0
ORDER BY epoch;

-- Verify we captured all the financial data
SELECT 
    '📊 COMPREHENSIVE FINANCIAL METRICS' as summary,
    COUNT(*) as total_epochs,
    COUNT(CASE WHEN storage_fee_fund_tokens > 0 THEN 1 END) as epochs_with_storage_fees,
    COUNT(CASE WHEN total_shares_tokens > 0 THEN 1 END) as epochs_with_shares_data,
    MAX(storage_fee_fund_tokens) as max_storage_fund_tokens,
    AVG(storage_fee_percentage) as avg_storage_percentage
FROM financial_analytics;

COMMIT;
