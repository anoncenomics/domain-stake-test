-- ========================================
-- OPERATOR SHARE PRICE NORMALIZATION MIGRATION
-- Step 1b: Create normalized tables only (functions already exist)
-- ========================================

BEGIN;

-- ========================================
-- CREATE NORMALIZED TABLES
-- ========================================

-- Operator share prices per epoch (primary table)
CREATE TABLE IF NOT EXISTS operator_share_prices (
  epoch INTEGER NOT NULL,
  operator_id INTEGER NOT NULL,
  share_price_perq NUMERIC(40, 0) NOT NULL,  -- 1e18 scaled perquintill
  source TEXT NOT NULL DEFAULT 'epochs_json',
  inserted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (epoch, operator_id)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_operator_share_prices_operator 
  ON operator_share_prices(operator_id, epoch);
CREATE INDEX IF NOT EXISTS idx_operator_share_prices_epoch 
  ON operator_share_prices(epoch);
-- BRIN index for very large datasets (epoch is monotonically increasing)
CREATE INDEX IF NOT EXISTS idx_operator_share_prices_epoch_brin 
  ON operator_share_prices USING BRIN(epoch);

-- Operator shares raw (for validation and additional metrics)
CREATE TABLE IF NOT EXISTS operator_shares (
  epoch INTEGER NOT NULL,
  operator_id INTEGER NOT NULL,
  shares_raw NUMERIC(40, 0) NOT NULL,
  stake_raw NUMERIC(40, 0),  -- Also store stake for easy ratio calculation
  inserted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (epoch, operator_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_shares_operator 
  ON operator_shares(operator_id, epoch);
CREATE INDEX IF NOT EXISTS idx_operator_shares_epoch 
  ON operator_shares(epoch);
CREATE INDEX IF NOT EXISTS idx_operator_shares_epoch_brin 
  ON operator_shares USING BRIN(epoch);

-- Operator metadata (for future use and better organization)
CREATE TABLE IF NOT EXISTS operators_metadata (
  operator_id INTEGER PRIMARY KEY,
  name TEXT,
  display_name TEXT,
  color TEXT,
  first_seen_epoch INTEGER,
  last_seen_epoch INTEGER,
  total_epochs_active INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create update trigger for updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers to tables
DROP TRIGGER IF EXISTS update_operator_share_prices_updated_at ON operator_share_prices;
CREATE TRIGGER update_operator_share_prices_updated_at 
  BEFORE UPDATE ON operator_share_prices 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_operator_shares_updated_at ON operator_shares;
CREATE TRIGGER update_operator_shares_updated_at 
  BEFORE UPDATE ON operator_shares 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_operators_metadata_updated_at ON operators_metadata;
CREATE TRIGGER update_operators_metadata_updated_at 
  BEFORE UPDATE ON operators_metadata 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ========================================
-- INITIAL OPERATOR METADATA
-- ========================================

-- Insert default metadata for known operators
INSERT INTO operators_metadata (operator_id, name, display_name, color, is_active) 
VALUES 
  (0, 'operator_0', 'Operator 0', '#3B82F6', true),
  (1, 'operator_1', 'Operator 1', '#EAB308', true),
  (2, 'operator_2', 'Operator 2', '#22C55E', true),
  (3, 'operator_3', 'Operator 3', '#EF4444', true)
ON CONFLICT (operator_id) DO UPDATE 
SET 
  updated_at = NOW(),
  is_active = EXCLUDED.is_active;

-- ========================================
-- VERIFICATION QUERIES
-- ========================================

-- Check that tables were created
SELECT 
  'Tables Created' as status,
  COUNT(*) as table_count,
  STRING_AGG(tablename, ', ' ORDER BY tablename) as tables
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('operator_share_prices', 'operator_shares', 'operators_metadata');

-- Check that functions exist
SELECT 
  'Functions Available' as status,
  COUNT(*) as function_count,
  STRING_AGG(routine_name, ', ' ORDER BY routine_name) as functions
FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_name IN ('parse_comma_number', 'hex_to_numeric', 'update_updated_at_column');

COMMIT;

-- ========================================
-- ROLLBACK SCRIPT (commented out, save for emergency)
-- ========================================

-- BEGIN;
-- DROP TABLE IF EXISTS operator_share_prices CASCADE;
-- DROP TABLE IF EXISTS operator_shares CASCADE;
-- DROP TABLE IF EXISTS operators_metadata CASCADE;
-- DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
-- COMMIT;
