-- ========================================
-- UPDATE COMPREHENSIVE ANALYTICS VIEW
-- Step 2: Extend view to use normalized operator data
-- ========================================

BEGIN;

-- ========================================
-- CREATE NEW COMPREHENSIVE VIEW WITH NORMALIZED DATA
-- ========================================

-- First, rename the old view for backup
ALTER MATERIALIZED VIEW IF EXISTS comprehensive_analytics RENAME TO comprehensive_analytics_old;

-- Create new comprehensive view that joins with normalized tables
CREATE MATERIALIZED VIEW comprehensive_analytics AS
SELECT 
  e.epoch,
  e.end_block,
  e.timestamp,
  TO_TIMESTAMP(e.timestamp / 1000) AS epoch_datetime,
  DATE(TO_TIMESTAMP(e.timestamp / 1000)) AS epoch_date,

  -- ========================================
  -- CORE METRICS FROM EPOCHS DATA
  -- ========================================
  
  -- Stake and shares
  parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') AS total_stake_raw,
  parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') / 1e18 AS total_stake_tokens,
  COALESCE((e.data->>'totalShares')::NUMERIC, 0) AS total_shares_raw,
  COALESCE((e.data->>'totalShares')::NUMERIC / 1e18, 0) AS total_shares_tokens,

  -- Network share price ratio
  CASE WHEN COALESCE((e.data->>'totalShares')::NUMERIC, 0) > 0
       THEN parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') / COALESCE((e.data->>'totalShares')::NUMERIC, 1)
       ELSE 1.0
  END AS network_share_price_ratio,

  -- Treasury and rewards
  COALESCE((e.data->>'accumulatedTreasuryFunds')::NUMERIC, 0) AS treasury_funds_raw,
  COALESCE((e.data->>'accumulatedTreasuryFunds')::NUMERIC / 1e18, 0) AS treasury_funds_tokens,
  COALESCE((e.data->>'domainChainRewards')::NUMERIC, 0) AS chain_rewards_raw,
  COALESCE((e.data->>'domainChainRewards')::NUMERIC / 1e18, 0) AS chain_rewards_tokens,

  -- Storage fee fund
  (
    SELECT SUM(
      hex_to_numeric(
        COALESCE(
          CASE 
            WHEN position(',' in (op_entry->>'value')) > 0 
            THEN (btrim(substr(op_entry->>'value', position(',' in (op_entry->>'value')) + 1))::jsonb ->> 'totalStorageFeeDeposit')
            ELSE NULL
          END,
          '0x0'
        )
      )
    )
    FROM jsonb_array_elements(e.data->'operators'->'entries') AS op_entry
  ) AS storage_fee_fund_raw,

  (
    SELECT SUM(
      hex_to_numeric(
        COALESCE(
          CASE 
            WHEN position(',' in (op_entry->>'value')) > 0 
            THEN (btrim(substr(op_entry->>'value', position(',' in (op_entry->>'value')) + 1))::jsonb ->> 'totalStorageFeeDeposit')
            ELSE NULL
          END,
          '0x0'
        )
      )
    )
    FROM jsonb_array_elements(e.data->'operators'->'entries') AS op_entry
  ) / 1e18 AS storage_fee_fund_tokens,

  -- ========================================
  -- OPERATOR SPECIFIC METRICS (0-3)
  -- Legacy columns for backward compatibility
  -- ========================================
  
  -- Operator 0
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) / 1e18, 0) AS operator_0_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'0')::TEXT) / 1e18, 0) AS operator_0_rewards_tokens,
  COALESCE(os0.shares_raw, 0) AS operator_0_shares_raw,
  COALESCE(osp0.share_price_perq / 1e18, 1) AS operator_0_share_price_tokens,
  
  -- Operator 1
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) / 1e18, 0) AS operator_1_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'1')::TEXT) / 1e18, 0) AS operator_1_rewards_tokens,
  COALESCE(os1.shares_raw, 0) AS operator_1_shares_raw,
  COALESCE(osp1.share_price_perq / 1e18, 1) AS operator_1_share_price_tokens,
  
  -- Operator 2
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'2')::TEXT) / 1e18, 0) AS operator_2_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'2')::TEXT) / 1e18, 0) AS operator_2_rewards_tokens,
  COALESCE(os2.shares_raw, 0) AS operator_2_shares_raw,
  COALESCE(osp2.share_price_perq / 1e18, 1) AS operator_2_share_price_tokens,
  
  -- Operator 3
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'3')::TEXT) / 1e18, 0) AS operator_3_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'3')::TEXT) / 1e18, 0) AS operator_3_rewards_tokens,
  COALESCE(os3.shares_raw, 0) AS operator_3_shares_raw,
  COALESCE(osp3.share_price_perq / 1e18, 1) AS operator_3_share_price_tokens,

  -- ========================================
  -- ACTIVITY METRICS
  -- ========================================
  
  COALESCE((e.data->'operators'->>'count')::INTEGER, 0) AS operator_count,
  COALESCE((e.data->'deposits'->>'count')::INTEGER, 0) AS deposits_count,
  COALESCE((e.data->'withdrawals'->>'count')::INTEGER, 0) AS withdrawals_count,
  COALESCE((e.data->'successfulBundles'->>'count')::INTEGER, 0) AS bundles_count,

  -- ========================================
  -- AGGREGATED OPERATOR DATA AS JSON
  -- For flexible operator support beyond 0-3
  -- ========================================
  
  (
    SELECT JSON_OBJECT_AGG(
      operator_id::TEXT, 
      share_price_perq::TEXT
    ) 
    FROM operator_share_prices osp 
    WHERE osp.epoch = e.epoch
    AND osp.operator_id <= 3  -- Limit to operators 0-3 for now
  ) AS operator_share_prices_json,
  
  (
    SELECT JSON_OBJECT_AGG(
      operator_id::TEXT,
      JSON_BUILD_OBJECT(
        'shares_raw', shares_raw::TEXT,
        'stake_raw', stake_raw::TEXT
      )
    )
    FROM operator_shares os
    WHERE os.epoch = e.epoch
    AND os.operator_id <= 3  -- Limit to operators 0-3 for now
  ) AS operator_shares_json

FROM epochs e

-- LEFT JOIN normalized tables for operators 0-3
LEFT JOIN operator_share_prices osp0 ON osp0.epoch = e.epoch AND osp0.operator_id = 0
LEFT JOIN operator_share_prices osp1 ON osp1.epoch = e.epoch AND osp1.operator_id = 1
LEFT JOIN operator_share_prices osp2 ON osp2.epoch = e.epoch AND osp2.operator_id = 2
LEFT JOIN operator_share_prices osp3 ON osp3.epoch = e.epoch AND osp3.operator_id = 3

LEFT JOIN operator_shares os0 ON os0.epoch = e.epoch AND os0.operator_id = 0
LEFT JOIN operator_shares os1 ON os1.epoch = e.epoch AND os1.operator_id = 1
LEFT JOIN operator_shares os2 ON os2.epoch = e.epoch AND os2.operator_id = 2
LEFT JOIN operator_shares os3 ON os3.epoch = e.epoch AND os3.operator_id = 3

ORDER BY e.epoch;

-- ========================================
-- RECREATE INDEXES
-- ========================================

CREATE INDEX IF NOT EXISTS idx_comprehensive_datetime ON comprehensive_analytics(epoch_datetime);
CREATE INDEX IF NOT EXISTS idx_comprehensive_date ON comprehensive_analytics(epoch_date);
CREATE INDEX IF NOT EXISTS idx_comprehensive_stake ON comprehensive_analytics(total_stake_tokens);
CREATE INDEX IF NOT EXISTS idx_comprehensive_storage ON comprehensive_analytics(storage_fee_fund_tokens);
CREATE INDEX IF NOT EXISTS idx_comprehensive_epoch ON comprehensive_analytics(epoch);

-- ========================================
-- REFRESH THE VIEW
-- ========================================

REFRESH MATERIALIZED VIEW comprehensive_analytics;

-- ========================================
-- VERIFICATION
-- ========================================

SELECT 
  'View Updated' as status,
  COUNT(*) as total_epochs,
  COUNT(operator_share_prices_json) as epochs_with_normalized_prices
FROM comprehensive_analytics;

-- Sample data check
SELECT 
  epoch,
  operator_0_stake_tokens,
  operator_0_share_price_tokens,
  operator_1_stake_tokens,
  operator_1_share_price_tokens,
  operator_share_prices_json
FROM comprehensive_analytics
WHERE epoch IN (1000, 2000, 3000)
ORDER BY epoch;

COMMIT;

-- ========================================
-- ROLLBACK (if needed)
-- ========================================

-- BEGIN;
-- DROP MATERIALIZED VIEW comprehensive_analytics;
-- ALTER MATERIALIZED VIEW comprehensive_analytics_old RENAME TO comprehensive_analytics;
-- COMMIT;
