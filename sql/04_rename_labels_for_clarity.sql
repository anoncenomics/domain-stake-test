-- ========================================
-- RENAME DATABASE LABELS FOR CLARITY
-- Step 4: Accurate naming to prevent confusion
-- ========================================

-- Note: This script renames columns and adds documentation
-- It should be run after validation that the system is working correctly

BEGIN;

-- ========================================
-- 1. RENAME NETWORK RATIO FOR CLARITY
-- ========================================

-- Update comprehensive_analytics to use clearer naming
-- (This requires recreating the view)
COMMENT ON COLUMN comprehensive_analytics.network_share_price_ratio IS 
'Network-wide stake/shares ratio. NOT a share price but a ratio. Floor is 1.0.';

-- ========================================
-- 2. ADD DOCUMENTATION TO EXISTING TABLES
-- ========================================

-- Document operator_share_prices table (actually contains nominator positions too)
COMMENT ON TABLE operator_share_prices IS 
'Share prices for both operators (IDs 0-3) and nominator positions (IDs > 3). 
Operators: calculated as stake/shares, increases with rewards.
Nominators: remains 1.0 until withdrawal initiated.';

COMMENT ON COLUMN operator_share_prices.operator_id IS 
'For IDs 0-3: actual operator ID. For IDs > 3: nominator position ID.';

COMMENT ON COLUMN operator_share_prices.share_price_perq IS 
'Share price in perquintill (1e18) scale. Floor is 1.0 (1e18).';

-- Document operator_shares table
COMMENT ON TABLE operator_shares IS 
'Stake and shares data for real operators (IDs 0-3 only).';

COMMENT ON COLUMN operator_shares.stake_raw IS 
'Total stake in smallest unit. Divide by 1e18 for token amount.';

COMMENT ON COLUMN operator_shares.shares_raw IS 
'Total shares in smallest unit. Divide by 1e18 for share amount.';

-- Document operators_metadata table
COMMENT ON TABLE operators_metadata IS 
'Metadata for real operators only (IDs 0-3).';

-- ========================================
-- 3. CREATE PROPERLY NAMED VIEWS
-- ========================================

-- Create a view specifically for operator analytics
CREATE OR REPLACE VIEW operator_analytics AS
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
  -- Calculate growth from floor price
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

-- Create a view for nominator position tracking
CREATE OR REPLACE VIEW nominator_position_tracker AS
WITH position_stats AS (
  SELECT 
    epoch,
    COUNT(*) as total_positions,
    COUNT(CASE WHEN share_price_perq = 1000000000000000000 THEN 1 END) as unwithdrawn_positions,
    COUNT(CASE WHEN share_price_perq > 1000000000000000000 THEN 1 END) as appreciated_positions,
    MIN(share_price_perq / 1e18) as min_price,
    MAX(share_price_perq / 1e18) as max_price,
    AVG(share_price_perq / 1e18) as avg_price
  FROM operator_share_prices
  WHERE operator_id > 3  -- Nominator positions only
  GROUP BY epoch
)
SELECT 
  epoch,
  total_positions,
  unwithdrawn_positions,
  appreciated_positions,
  ROUND((appreciated_positions::NUMERIC / NULLIF(total_positions, 0) * 100), 2) as appreciated_percent,
  ROUND(min_price::NUMERIC, 6) as min_price,
  ROUND(max_price::NUMERIC, 6) as max_price,
  ROUND(avg_price::NUMERIC, 6) as avg_price
FROM position_stats
ORDER BY epoch DESC;

COMMENT ON VIEW nominator_position_tracker IS 
'Tracks nominator positions (IDs > 3) and their withdrawal status based on share price.';

-- ========================================
-- 4. ADD VALIDATION CONSTRAINTS
-- ========================================

-- Ensure share prices respect the floor of 1.0
ALTER TABLE operator_share_prices 
DROP CONSTRAINT IF EXISTS check_min_share_price;

ALTER TABLE operator_share_prices 
ADD CONSTRAINT check_min_share_price 
CHECK (share_price_perq >= 1000000000000000000)
NOT VALID;  -- Don't validate existing data immediately

-- Validate the constraint separately (can be done async)
-- ALTER TABLE operator_share_prices VALIDATE CONSTRAINT check_min_share_price;

-- ========================================
-- 5. CREATE HELPER FUNCTIONS
-- ========================================

-- Function to classify an ID as operator or nominator
CREATE OR REPLACE FUNCTION classify_position_type(position_id BIGINT)
RETURNS TEXT AS $$
BEGIN
  IF position_id <= 3 THEN
    RETURN 'operator';
  ELSE
    RETURN 'nominator';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION classify_position_type IS 
'Returns "operator" for IDs 0-3, "nominator" for IDs > 3';

-- Function to explain share price
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
      RETURN 'ERROR: Below floor price';
    END IF;
  ELSE
    -- Nominator
    IF price_perq = 1000000000000000000 THEN
      RETURN 'Nominator position not withdrawn';
    ELSIF price_perq > 1000000000000000000 THEN
      RETURN 'Nominator position with calculated withdrawal price';
    ELSE
      RETURN 'ERROR: Below floor price';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION explain_share_price IS 
'Provides human-readable explanation of share price based on position type';

-- ========================================
-- 6. VERIFICATION QUERIES
-- ========================================

-- Show the new structure in action
SELECT 'Database Labels Updated' as status;

-- Sample operator analytics
SELECT 
  epoch,
  operator_id,
  operator_name,
  ROUND(stake_tokens::NUMERIC, 2) as stake_tokens,
  ROUND(share_price::NUMERIC, 6) as share_price,
  ROUND(price_growth_percent::NUMERIC, 4) as growth_pct
FROM operator_analytics
WHERE epoch IN (1000, 2000, 3000)
ORDER BY epoch, operator_id
LIMIT 12;

-- Sample nominator tracking
SELECT 
  epoch,
  total_positions,
  unwithdrawn_positions,
  appreciated_percent,
  avg_price
FROM nominator_position_tracker
WHERE epoch % 500 = 0
ORDER BY epoch DESC
LIMIT 8;

COMMIT;

-- ========================================
-- USAGE EXAMPLES
-- ========================================

-- Example 1: Check position type
-- SELECT operator_id, classify_position_type(operator_id) as type
-- FROM operator_share_prices 
-- WHERE epoch = 3000 
-- LIMIT 10;

-- Example 2: Explain share prices
-- SELECT 
--   operator_id,
--   share_price_perq / 1e18 as price,
--   explain_share_price(share_price_perq, operator_id) as explanation
-- FROM operator_share_prices 
-- WHERE epoch = 3000 
-- AND operator_id IN (0, 1, 100, 1000);
