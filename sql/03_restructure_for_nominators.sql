-- ========================================
-- RESTRUCTURE DATA MODEL FOR NOMINATORS
-- Step 3: Properly categorize operators vs nominator positions
-- ========================================

BEGIN;

-- ========================================
-- CREATE VIEWS TO SEPARATE DATA TYPES
-- ========================================

-- View for real operators only (IDs 0-3)
CREATE OR REPLACE VIEW real_operator_share_prices AS
SELECT 
  epoch,
  operator_id,
  share_price_perq,
  share_price_perq / 1e18 as share_price_decimal,
  source,
  inserted_at,
  updated_at
FROM operator_share_prices
WHERE operator_id <= 3
ORDER BY epoch, operator_id;

-- View for real operator stakes
CREATE OR REPLACE VIEW real_operator_stakes AS
SELECT 
  epoch,
  operator_id,
  shares_raw,
  stake_raw,
  stake_raw / 1e18 as stake_tokens,
  shares_raw / 1e18 as shares_tokens,
  CASE 
    WHEN shares_raw > 0 
    THEN (stake_raw::NUMERIC / shares_raw::NUMERIC)
    ELSE 1.0
  END as calculated_share_price,
  inserted_at,
  updated_at
FROM operator_shares
WHERE operator_id <= 3
ORDER BY epoch, operator_id;

-- View for nominator positions (IDs > 3)
CREATE OR REPLACE VIEW nominator_positions AS
SELECT 
  epoch,
  operator_id as position_id,  -- These are actually position IDs, not operator IDs
  share_price_perq,
  share_price_perq / 1e18 as share_price_decimal,
  source,
  inserted_at,
  updated_at
FROM operator_share_prices
WHERE operator_id > 3
ORDER BY epoch, operator_id;

-- ========================================
-- ANALYSIS VIEWS
-- ========================================

-- Operator summary statistics
CREATE OR REPLACE VIEW operator_summary AS
SELECT 
  ros.operator_id,
  om.display_name,
  COUNT(DISTINCT ros.epoch) as active_epochs,
  MIN(ros.epoch) as first_epoch,
  MAX(ros.epoch) as last_epoch,
  AVG(rosp.share_price_perq / 1e18) as avg_share_price,
  MIN(rosp.share_price_perq / 1e18) as min_share_price,
  MAX(rosp.share_price_perq / 1e18) as max_share_price,
  AVG(ros.stake_raw / 1e18) as avg_stake_tokens,
  AVG(ros.shares_raw / 1e18) as avg_shares_tokens
FROM real_operator_stakes ros
LEFT JOIN real_operator_share_prices rosp 
  ON ros.epoch = rosp.epoch AND ros.operator_id = rosp.operator_id
LEFT JOIN operators_metadata om 
  ON ros.operator_id = om.operator_id
GROUP BY ros.operator_id, om.display_name
ORDER BY ros.operator_id;

-- Nominator growth over time
CREATE OR REPLACE VIEW nominator_growth AS
WITH epoch_counts AS (
  SELECT 
    epoch,
    COUNT(DISTINCT position_id) as position_count,
    MIN(share_price_decimal) as min_price,
    MAX(share_price_decimal) as max_price,
    AVG(share_price_decimal) as avg_price
  FROM nominator_positions
  GROUP BY epoch
)
SELECT 
  epoch,
  position_count,
  position_count - LAG(position_count) OVER (ORDER BY epoch) as new_positions,
  min_price,
  max_price,
  avg_price
FROM epoch_counts
ORDER BY epoch;

-- ========================================
-- ENHANCED COMPREHENSIVE ANALYTICS
-- ========================================

-- Drop and recreate comprehensive_analytics with proper understanding
DROP MATERIALIZED VIEW IF EXISTS comprehensive_analytics CASCADE;

CREATE MATERIALIZED VIEW comprehensive_analytics AS
SELECT 
  e.epoch,
  e.end_block,
  e.timestamp,
  TO_TIMESTAMP(e.timestamp / 1000) AS epoch_datetime,
  DATE(TO_TIMESTAMP(e.timestamp / 1000)) AS epoch_date,

  -- Core metrics
  parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') AS total_stake_raw,
  parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') / 1e18 AS total_stake_tokens,
  COALESCE((e.data->>'totalShares')::NUMERIC, 0) AS total_shares_raw,
  COALESCE((e.data->>'totalShares')::NUMERIC / 1e18, 0) AS total_shares_tokens,

  -- Network share price
  CASE WHEN COALESCE((e.data->>'totalShares')::NUMERIC, 0) > 0
       THEN parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') / COALESCE((e.data->>'totalShares')::NUMERIC, 1)
       ELSE 1.0
  END AS network_share_price_ratio,

  -- Treasury and rewards
  COALESCE((e.data->>'accumulatedTreasuryFunds')::NUMERIC / 1e18, 0) AS treasury_funds_tokens,
  COALESCE((e.data->>'domainChainRewards')::NUMERIC / 1e18, 0) AS chain_rewards_tokens,

  -- Storage fees
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

  -- Real operator metrics (0-3 only)
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) / 1e18, 0) AS operator_0_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'0')::TEXT) / 1e18, 0) AS operator_0_rewards_tokens,
  COALESCE(rosp0.share_price_decimal, 1.0) AS operator_0_share_price,
  
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) / 1e18, 0) AS operator_1_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'1')::TEXT) / 1e18, 0) AS operator_1_rewards_tokens,
  COALESCE(rosp1.share_price_decimal, 1.0) AS operator_1_share_price,
  
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'2')::TEXT) / 1e18, 0) AS operator_2_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'2')::TEXT) / 1e18, 0) AS operator_2_rewards_tokens,
  COALESCE(rosp2.share_price_decimal, 1.0) AS operator_2_share_price,
  
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentOperators'->>'3')::TEXT) / 1e18, 0) AS operator_3_stake_tokens,
  COALESCE(parse_comma_number((e.data->'domainStakingSummary'->'currentEpochRewards'->>'3')::TEXT) / 1e18, 0) AS operator_3_rewards_tokens,
  COALESCE(rosp3.share_price_decimal, 1.0) AS operator_3_share_price,

  -- Counts
  COALESCE((e.data->'operators'->>'count')::INTEGER, 0) AS real_operator_count,
  COALESCE((
    SELECT COUNT(DISTINCT position_id) 
    FROM nominator_positions np 
    WHERE np.epoch = e.epoch
  ), 0) AS nominator_position_count,
  COALESCE((e.data->'deposits'->>'count')::INTEGER, 0) AS deposits_count,
  COALESCE((e.data->'withdrawals'->>'count')::INTEGER, 0) AS withdrawals_count,
  COALESCE((e.data->'successfulBundles'->>'count')::INTEGER, 0) AS bundles_count

FROM epochs e

-- Join real operator share prices
LEFT JOIN real_operator_share_prices rosp0 ON rosp0.epoch = e.epoch AND rosp0.operator_id = 0
LEFT JOIN real_operator_share_prices rosp1 ON rosp1.epoch = e.epoch AND rosp1.operator_id = 1
LEFT JOIN real_operator_share_prices rosp2 ON rosp2.epoch = e.epoch AND rosp2.operator_id = 2
LEFT JOIN real_operator_share_prices rosp3 ON rosp3.epoch = e.epoch AND rosp3.operator_id = 3

ORDER BY e.epoch;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_comprehensive_epoch ON comprehensive_analytics(epoch);
CREATE INDEX IF NOT EXISTS idx_comprehensive_datetime ON comprehensive_analytics(epoch_datetime);

-- Refresh the view
REFRESH MATERIALIZED VIEW comprehensive_analytics;

-- ========================================
-- VERIFICATION
-- ========================================

-- Check the new structure
SELECT 
  'Restructure Complete' as status,
  (SELECT COUNT(*) FROM real_operator_share_prices) as real_operator_prices,
  (SELECT COUNT(*) FROM nominator_positions) as nominator_positions,
  (SELECT COUNT(*) FROM comprehensive_analytics) as total_epochs;

-- Sample the corrected data
SELECT 
  epoch,
  real_operator_count,
  nominator_position_count,
  ROUND(operator_0_share_price::NUMERIC, 6) as op0_price,
  ROUND(operator_1_share_price::NUMERIC, 6) as op1_price
FROM comprehensive_analytics
WHERE epoch IN (100, 1000, 2000, 3000)
ORDER BY epoch;

COMMIT;

-- ========================================
-- ANALYSIS QUERIES (for reference)
-- ========================================

-- Query 1: Real operator performance over time
-- SELECT * FROM operator_summary;

-- Query 2: Nominator growth pattern
-- SELECT * FROM nominator_growth WHERE epoch % 100 = 0 ORDER BY epoch;

-- Query 3: Latest operator share prices
-- SELECT * FROM real_operator_share_prices WHERE epoch = (SELECT MAX(epoch) FROM epochs);

-- Query 4: Nominator position distribution
-- SELECT 
--   epoch,
--   COUNT(*) as positions,
--   AVG(share_price_decimal) as avg_price,
--   STDDEV(share_price_decimal) as price_variance
-- FROM nominator_positions
-- GROUP BY epoch
-- ORDER BY epoch DESC
-- LIMIT 10;
