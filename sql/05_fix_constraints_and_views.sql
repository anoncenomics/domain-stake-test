-- ========================================
-- FIX CONSTRAINTS AND CREATE MISSING VIEWS
-- Step 5: Correct understanding of nominator prices
-- ========================================

BEGIN;

-- ========================================
-- 1. FIX SHARE PRICE CONSTRAINT
-- ========================================

-- Remove the incorrect blanket constraint
ALTER TABLE operator_share_prices 
DROP CONSTRAINT IF EXISTS check_min_share_price;

-- Add correct constraint: only operators have floor of 1.0
ALTER TABLE operator_share_prices 
ADD CONSTRAINT check_operator_floor_price 
CHECK (
  -- Operators (0-3) must have share price >= 1.0
  -- Nominators (>3) can have any positive price
  (operator_id <= 3 AND share_price_perq >= 1000000000000000000) OR
  (operator_id > 3 AND share_price_perq > 0)
);

COMMENT ON CONSTRAINT check_operator_floor_price ON operator_share_prices IS 
'Operators (0-3) have floor of 1.0, nominators can depreciate below 1.0';

-- ========================================
-- 2. CREATE MISSING VIEWS PROPERLY
-- ========================================

-- Drop if exists and recreate operator_analytics
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
  -- Calculate growth from floor price (always positive for operators)
  ((osp.share_price_perq / 1e18) - 1.0) * 100 as price_growth_percent,
  osp.source,
  os.updated_at
FROM operator_shares os
JOIN operator_share_prices osp ON os.epoch = osp.epoch AND os.operator_id = osp.operator_id
LEFT JOIN operators_metadata om ON os.operator_id = om.operator_id
WHERE os.operator_id <= 3  -- Real operators only
ORDER BY os.epoch DESC, os.operator_id;

COMMENT ON VIEW operator_analytics IS 
'Analytics view for real operators (IDs 0-3) showing stake, shares, and price calculations.';

-- Drop if exists and recreate nominator_position_tracker
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
'Tracks nominator positions (IDs > 3) including appreciation and depreciation from initial 1.0 price.';

-- ========================================
-- 3. CREATE P&L VIEW FOR NOMINATORS
-- ========================================

CREATE OR REPLACE VIEW nominator_pnl AS
WITH position_changes AS (
  SELECT 
    operator_id as position_id,
    epoch,
    share_price_perq / 1e18 as share_price,
    (share_price_perq / 1e18 - 1.0) * 100 as pnl_percent,
    CASE 
      WHEN share_price_perq = 1000000000000000000 THEN 'Unchanged'
      WHEN share_price_perq > 1000000000000000000 THEN 'Profit'
      WHEN share_price_perq < 1000000000000000000 THEN 'Loss'
    END as pnl_status
  FROM operator_share_prices
  WHERE operator_id > 3
)
SELECT 
  epoch,
  COUNT(*) as total_positions,
  COUNT(CASE WHEN pnl_status = 'Profit' THEN 1 END) as profitable_positions,
  COUNT(CASE WHEN pnl_status = 'Loss' THEN 1 END) as losing_positions,
  COUNT(CASE WHEN pnl_status = 'Unchanged' THEN 1 END) as unchanged_positions,
  ROUND(AVG(CASE WHEN pnl_status = 'Profit' THEN pnl_percent END)::NUMERIC, 4) as avg_profit_pct,
  ROUND(AVG(CASE WHEN pnl_status = 'Loss' THEN pnl_percent END)::NUMERIC, 4) as avg_loss_pct,
  ROUND(MAX(pnl_percent)::NUMERIC, 4) as max_gain_pct,
  ROUND(MIN(pnl_percent)::NUMERIC, 4) as max_loss_pct
FROM position_changes
GROUP BY epoch
ORDER BY epoch DESC;

COMMENT ON VIEW nominator_pnl IS 
'Profit and Loss analysis for nominator positions showing gains and losses from initial 1.0 price.';

-- ========================================
-- 4. UPDATE HELPER FUNCTIONS
-- ========================================

-- Update the explain_share_price function to handle depreciation
CREATE OR REPLACE FUNCTION explain_share_price(price_perq NUMERIC, position_id BIGINT)
RETURNS TEXT AS $$
BEGIN
  IF position_id <= 3 THEN
    -- Operator
    IF price_perq = 1000000000000000000 THEN
      RETURN 'Operator at floor (no rewards yet)';
    ELSIF price_perq > 1000000000000000000 THEN
      RETURN 'Operator with ' || ROUND(((price_perq / 1e18) - 1) * 100, 4)::TEXT || '% appreciation';
    ELSE
      RETURN 'ERROR: Operator below floor price';
    END IF;
  ELSE
    -- Nominator
    IF price_perq = 1000000000000000000 THEN
      RETURN 'Nominator position unchanged (1.0)';
    ELSIF price_perq > 1000000000000000000 THEN
      RETURN 'Nominator with ' || ROUND(((price_perq / 1e18) - 1) * 100, 4)::TEXT || '% gain';
    ELSIF price_perq < 1000000000000000000 AND price_perq > 0 THEN
      RETURN 'Nominator with ' || ROUND(((price_perq / 1e18) - 1) * 100, 4)::TEXT || '% loss';
    ELSE
      RETURN 'ERROR: Invalid price';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ========================================
-- 5. VERIFICATION
-- ========================================

-- Check constraint is working
SELECT 
  'Constraint Status' as check_type,
  COUNT(CASE WHEN operator_id <= 3 AND share_price_perq < 1000000000000000000 THEN 1 END) as operator_violations,
  COUNT(CASE WHEN operator_id > 3 AND share_price_perq <= 0 THEN 1 END) as nominator_violations
FROM operator_share_prices;

-- Sample the new P&L view
SELECT 
  epoch,
  total_positions,
  profitable_positions,
  losing_positions,
  avg_profit_pct,
  avg_loss_pct,
  max_gain_pct,
  max_loss_pct
FROM nominator_pnl
WHERE epoch IN (1000, 2000, 3000)
ORDER BY epoch;

-- Check nominator position distribution
SELECT 
  epoch,
  total_positions,
  appreciated_pct,
  depreciated_pct,
  min_price,
  max_price
FROM nominator_position_tracker
WHERE epoch % 500 = 0
ORDER BY epoch DESC
LIMIT 8;

COMMIT;

-- ========================================
-- Summary of Changes
-- ========================================
-- 1. Fixed constraint to allow nominator depreciation
-- 2. Created operator_analytics view
-- 3. Created nominator_position_tracker view with depreciation tracking
-- 4. Added nominator_pnl view for profit/loss analysis
-- 5. Updated helper functions to handle losses
