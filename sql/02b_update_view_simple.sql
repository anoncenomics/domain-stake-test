-- ========================================
-- UPDATE COMPREHENSIVE ANALYTICS VIEW - SIMPLIFIED
-- Step 2b: Drop and recreate view with normalized data
-- ========================================

BEGIN;

-- Drop old view if exists
DROP MATERIALIZED VIEW IF EXISTS comprehensive_analytics CASCADE;

-- Create new comprehensive view that uses normalized tables
CREATE MATERIALIZED VIEW comprehensive_analytics AS
SELECT 
  e.epoch,
  e.end_block,
  e.timestamp,
  TO_TIMESTAMP(e.timestamp / 1000) AS epoch_datetime,
  DATE(TO_TIMESTAMP(e.timestamp / 1000)) AS epoch_date,

  -- Core metrics from epochs data
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
  COALESCE((
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
  ), 0) AS storage_fee_fund_raw,

  COALESCE((
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
  ), 0) / 1e18 AS storage_fee_fund_tokens,

  -- Operator specific metrics (0-3) for backward compatibility
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) / 1e18, 0) AS operator_0_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'0')::TEXT) / 1e18, 0) AS operator_0_rewards_tokens,
  
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) / 1e18, 0) AS operator_1_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'1')::TEXT) / 1e18, 0) AS operator_1_rewards_tokens,
  
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'2')::TEXT) / 1e18, 0) AS operator_2_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'2')::TEXT) / 1e18, 0) AS operator_2_rewards_tokens,
  
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'3')::TEXT) / 1e18, 0) AS operator_3_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'3')::TEXT) / 1e18, 0) AS operator_3_rewards_tokens,

  -- Activity metrics
  COALESCE((e.data->'operators'->>'count')::INTEGER, 0) AS operator_count,
  COALESCE((e.data->'deposits'->>'count')::INTEGER, 0) AS deposits_count,
  COALESCE((e.data->'withdrawals'->>'count')::INTEGER, 0) AS withdrawals_count,
  COALESCE((e.data->'successfulBundles'->>'count')::INTEGER, 0) AS bundles_count

FROM epochs e
ORDER BY e.epoch;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_comprehensive_datetime ON comprehensive_analytics(epoch_datetime);
CREATE INDEX IF NOT EXISTS idx_comprehensive_date ON comprehensive_analytics(epoch_date);
CREATE INDEX IF NOT EXISTS idx_comprehensive_stake ON comprehensive_analytics(total_stake_tokens);
CREATE INDEX IF NOT EXISTS idx_comprehensive_epoch ON comprehensive_analytics(epoch);

-- Refresh the view
REFRESH MATERIALIZED VIEW comprehensive_analytics;

-- Verify the update
SELECT 
  'View Updated' as status,
  COUNT(*) as total_epochs
FROM comprehensive_analytics;

COMMIT;
