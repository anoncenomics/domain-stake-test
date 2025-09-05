-- ========================================
-- CREATE VIEWS WITHOUT CONSTRAINTS
-- Step 5b: Views only (constraints need more investigation)
-- ========================================

-- Note: Even operators 2 and 3 have prices below 1.0
-- This suggests ALL positions can depreciate

BEGIN;

-- ========================================
-- 1. CREATE OPERATOR ANALYTICS VIEW
-- ========================================

DROP VIEW IF EXISTS operator_analytics CASCADE;

CREATE VIEW operator_analytics AS
SELECT 
  os.epoch,
  os.operator_id,
  om.display_name as operator_name,
  os.stake_raw,
  os.stake_raw / 1e18 as stake_tokens,
  os.shares_raw,
  os.shares_raw / 1e18 as shares_tokens,
  osp.share_price_perq,
  osp.share_price_perq / 1e18 as share_price,
  -- P&L from initial 1.0 (can be negative)
  ((osp.share_price_perq / 1e18) - 1.0) * 100 as price_change_percent,
  CASE 
    WHEN osp.share_price_perq = 1e18 THEN 'Unchanged'
    WHEN osp.share_price_perq > 1e18 THEN 'Appreciated'
    WHEN osp.share_price_perq < 1e18 THEN 'Depreciated'
  END as price_status,
  osp.source,
  os.updated_at
FROM operator_shares os
JOIN operator_share_prices osp ON os.epoch = osp.epoch AND os.operator_id = osp.operator_id
LEFT JOIN operators_metadata om ON os.operator_id = om.operator_id
WHERE os.operator_id <= 3  -- Real operators only
ORDER BY os.epoch DESC, os.operator_id;

COMMENT ON VIEW operator_analytics IS 
'Analytics for real operators (0-3). Note: Even operators can have prices below 1.0';

-- ========================================
-- 2. CREATE NOMINATOR POSITION TRACKER
-- ========================================

DROP VIEW IF EXISTS nominator_position_tracker CASCADE;

CREATE VIEW nominator_position_tracker AS
WITH position_stats AS (
  SELECT 
    epoch,
    COUNT(*) as total_positions,
    -- Positions at exactly 1.0 (initial/unmoved)
    COUNT(CASE WHEN share_price_perq = 1000000000000000000 THEN 1 END) as unchanged_positions,
    -- Positions that appreciated (>1.0)
    COUNT(CASE WHEN share_price_perq > 1000000000000000000 THEN 1 END) as appreciated_positions,
    -- Positions that depreciated (<1.0)
    COUNT(CASE WHEN share_price_perq < 1000000000000000000 THEN 1 END) as depreciated_positions,
    MIN(share_price_perq / 1e18) as min_price,
    MAX(share_price_perq / 1e18) as max_price,
    AVG(share_price_perq / 1e18) as avg_price,
    STDDEV(share_price_perq / 1e18) as price_volatility
  FROM operator_share_prices
  WHERE operator_id > 3  -- Nominator positions only
  GROUP BY epoch
)
SELECT 
  epoch,
  total_positions,
  unchanged_positions,
  appreciated_positions,
  depreciated_positions,
  ROUND((appreciated_positions::NUMERIC / NULLIF(total_positions, 0) * 100), 2) as appreciated_pct,
  ROUND((depreciated_positions::NUMERIC / NULLIF(total_positions, 0) * 100), 2) as depreciated_pct,
  ROUND(min_price::NUMERIC, 6) as min_price,
  ROUND(max_price::NUMERIC, 6) as max_price,
  ROUND(avg_price::NUMERIC, 6) as avg_price,
  ROUND(price_volatility::NUMERIC, 6) as volatility
FROM position_stats
ORDER BY epoch DESC;

COMMENT ON VIEW nominator_position_tracker IS 
'Tracks nominator positions (IDs > 3) including appreciation and depreciation';

-- ========================================
-- 3. CREATE COMPREHENSIVE P&L VIEW
-- ========================================

DROP VIEW IF EXISTS position_pnl_analysis CASCADE;

CREATE VIEW position_pnl_analysis AS
WITH all_positions AS (
  SELECT 
    operator_id,
    epoch,
    share_price_perq / 1e18 as share_price,
    (share_price_perq / 1e18 - 1.0) * 100 as pnl_percent,
    CASE 
      WHEN operator_id <= 3 THEN 'Operator'
      ELSE 'Nominator'
    END as position_type,
    CASE 
      WHEN share_price_perq = 1000000000000000000 THEN 'Unchanged'
      WHEN share_price_perq > 1000000000000000000 THEN 'Profit'
      WHEN share_price_perq < 1000000000000000000 THEN 'Loss'
    END as pnl_status
  FROM operator_share_prices
)
SELECT 
  epoch,
  position_type,
  COUNT(*) as total_positions,
  COUNT(CASE WHEN pnl_status = 'Profit' THEN 1 END) as profitable,
  COUNT(CASE WHEN pnl_status = 'Loss' THEN 1 END) as losing,
  COUNT(CASE WHEN pnl_status = 'Unchanged' THEN 1 END) as unchanged,
  ROUND(AVG(pnl_percent)::NUMERIC, 4) as avg_pnl_pct,
  ROUND(MIN(pnl_percent)::NUMERIC, 4) as worst_loss_pct,
  ROUND(MAX(pnl_percent)::NUMERIC, 4) as best_gain_pct
FROM all_positions
GROUP BY epoch, position_type
ORDER BY epoch DESC, position_type;

COMMENT ON VIEW position_pnl_analysis IS 
'P&L analysis for both operators and nominators showing performance vs initial 1.0 price';

-- ========================================
-- 4. CREATE NETWORK HEALTH VIEW
-- ========================================

DROP VIEW IF EXISTS network_health_metrics CASCADE;

CREATE VIEW network_health_metrics AS
WITH latest_epoch AS (
  SELECT MAX(epoch) as max_epoch FROM epochs
)
SELECT 
  e.epoch,
  e.epoch_datetime,
  -- Operator health
  (SELECT COUNT(DISTINCT operator_id) FROM operator_shares WHERE epoch = e.epoch AND operator_id <= 3) as active_operators,
  (SELECT AVG(share_price_perq / 1e18) FROM operator_share_prices WHERE epoch = e.epoch AND operator_id <= 3) as avg_operator_price,
  -- Nominator health  
  (SELECT COUNT(DISTINCT operator_id) FROM operator_share_prices WHERE epoch = e.epoch AND operator_id > 3) as nominator_positions,
  (SELECT AVG(share_price_perq / 1e18) FROM operator_share_prices WHERE epoch = e.epoch AND operator_id > 3) as avg_nominator_price,
  -- Network metrics
  e.total_stake_tokens,
  e.total_shares_tokens,
  e.network_share_price_ratio,
  e.deposits_count,
  e.withdrawals_count,
  -- Profitability
  (SELECT COUNT(*) FROM operator_share_prices WHERE epoch = e.epoch AND share_price_perq > 1e18) as profitable_positions,
  (SELECT COUNT(*) FROM operator_share_prices WHERE epoch = e.epoch AND share_price_perq < 1e18) as losing_positions
FROM comprehensive_analytics e
WHERE e.epoch >= (SELECT max_epoch - 100 FROM latest_epoch)
ORDER BY e.epoch DESC;

COMMENT ON VIEW network_health_metrics IS 
'Network-wide health metrics combining operator and nominator performance';

-- ========================================
-- 5. VERIFICATION
-- ========================================

-- Check views are created
SELECT 
  'Views Created' as status,
  (SELECT COUNT(*) FROM information_schema.views WHERE table_name = 'operator_analytics') as operator_analytics,
  (SELECT COUNT(*) FROM information_schema.views WHERE table_name = 'nominator_position_tracker') as nominator_tracker,
  (SELECT COUNT(*) FROM information_schema.views WHERE table_name = 'position_pnl_analysis') as pnl_analysis,
  (SELECT COUNT(*) FROM information_schema.views WHERE table_name = 'network_health_metrics') as health_metrics;

-- Sample operator data showing depreciation
SELECT 
  operator_id,
  operator_name,
  MIN(share_price) as min_price,
  MAX(share_price) as max_price,
  AVG(share_price) as avg_price,
  COUNT(CASE WHEN price_status = 'Depreciated' THEN 1 END) as depreciated_epochs,
  COUNT(CASE WHEN price_status = 'Appreciated' THEN 1 END) as appreciated_epochs
FROM operator_analytics
GROUP BY operator_id, operator_name
ORDER BY operator_id;

-- Sample P&L analysis
SELECT 
  epoch,
  position_type,
  total_positions,
  profitable,
  losing,
  avg_pnl_pct,
  worst_loss_pct,
  best_gain_pct
FROM position_pnl_analysis
WHERE epoch IN (1000, 2000, 3000)
ORDER BY epoch, position_type;

COMMIT;

-- ========================================
-- KEY FINDING DOCUMENTED
-- ========================================
-- Even operators can have share prices below 1.0!
-- Operator 2: min 0.999966
-- Operator 3: min 0.999966
-- This suggests network-wide economic mechanisms
-- affecting all participants, not just nominators
