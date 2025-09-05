-- Update comprehensive_analytics: add operator_2/3 metrics and robust storage-fee extractor

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS comprehensive_analytics;

CREATE MATERIALIZED VIEW comprehensive_analytics AS
SELECT 
  epoch,
  end_block,
  timestamp,
  TO_TIMESTAMP(timestamp / 1000) AS epoch_datetime,
  DATE(TO_TIMESTAMP(timestamp / 1000)) AS epoch_date,

  -- stake and shares
  parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') AS total_stake_raw,
  parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / 1e18 AS total_stake_tokens,
  COALESCE((data->>'totalShares')::NUMERIC, 0) AS total_shares_raw,
  COALESCE((data->>'totalShares')::NUMERIC / 1e18, 0) AS total_shares_tokens,

  CASE WHEN COALESCE((data->>'totalShares')::NUMERIC, 0) > 0
       THEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') / COALESCE((data->>'totalShares')::NUMERIC, 1)
       ELSE 1.0
  END AS network_share_price_ratio,

  -- treasury and rewards (network-level)
  COALESCE((data->>'accumulatedTreasuryFunds')::NUMERIC, 0) AS treasury_funds_raw,
  COALESCE((data->>'accumulatedTreasuryFunds')::NUMERIC / 1e18, 0) AS treasury_funds_tokens,
  COALESCE((data->>'domainChainRewards')::NUMERIC, 0) AS chain_rewards_raw,
  COALESCE((data->>'domainChainRewards')::NUMERIC / 1e18, 0) AS chain_rewards_tokens,

  -- storage fee fund (parse operator entry 'value' JSON payload)
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
    FROM jsonb_array_elements(data->'operators'->'entries') AS op_entry
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
    FROM jsonb_array_elements(data->'operators'->'entries') AS op_entry
  ) / 1e18 AS storage_fee_fund_tokens,

  CASE WHEN parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake') > 0
       THEN (
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
           FROM jsonb_array_elements(data->'operators'->'entries') AS op_entry
         ) * 100.0 / parse_comma_number(data->'domainStakingSummary'->>'currentTotalStake')
       )
       ELSE 0 END AS storage_fee_percentage,

  -- operators 0..3 stake and rewards
  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) / 1e18, 0) AS operator_0_stake_tokens,
  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentEpochRewards'->>'0')::TEXT) / 1e18, 0) AS operator_0_rewards_tokens,

  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) / 1e18, 0) AS operator_1_stake_tokens,
  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentEpochRewards'->>'1')::TEXT) / 1e18, 0) AS operator_1_rewards_tokens,

  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'2')::TEXT) / 1e18, 0) AS operator_2_stake_tokens,
  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentEpochRewards'->>'2')::TEXT) / 1e18, 0) AS operator_2_rewards_tokens,

  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'3')::TEXT) / 1e18, 0) AS operator_3_stake_tokens,
  COALESCE(parse_comma_number((data->'domainStakingSummary'->'currentEpochRewards'->>'3')::TEXT) / 1e18, 0) AS operator_3_rewards_tokens,

  -- operators 0..3 currentTotalShares (raw) extracted from operators.entries[].value payload
  (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    )
    FROM jsonb_array_elements(data->'operators'->'entries') AS e(op)
    WHERE (op->'key'->>0) = '0'
    LIMIT 1
  ) AS operator_0_shares_raw,

  (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    )
    FROM jsonb_array_elements(data->'operators'->'entries') AS e(op)
    WHERE (op->'key'->>0) = '1'
    LIMIT 1
  ) AS operator_1_shares_raw,

  (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    )
    FROM jsonb_array_elements(data->'operators'->'entries') AS e(op)
    WHERE (op->'key'->>0) = '2'
    LIMIT 1
  ) AS operator_2_shares_raw,

  (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    )
    FROM jsonb_array_elements(data->'operators'->'entries') AS e(op)
    WHERE (op->'key'->>0) = '3'
    LIMIT 1
  ) AS operator_3_shares_raw,

  -- tokens-per-share (approx) using domainStakingSummary stake raw over shares raw
  CASE WHEN (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '0' LIMIT 1
  ) > 0
  THEN (parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'0')::TEXT) / (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '0' LIMIT 1
  )) / 1e18 ELSE NULL END AS operator_0_share_price_tokens,

  CASE WHEN (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '1' LIMIT 1
  ) > 0
  THEN (parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'1')::TEXT) / (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '1' LIMIT 1
  )) / 1e18 ELSE NULL END AS operator_1_share_price_tokens,

  CASE WHEN (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '2' LIMIT 1
  ) > 0
  THEN (parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'2')::TEXT) / (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '2' LIMIT 1
  )) / 1e18 ELSE NULL END AS operator_2_share_price_tokens,

  CASE WHEN (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '3' LIMIT 1
  ) > 0
  THEN (parse_comma_number((data->'domainStakingSummary'->'currentOperators'->>'3')::TEXT) / (
    SELECT hex_to_numeric(
      COALESCE(
        CASE WHEN position(',' in (op->>'value')) > 0 THEN (btrim(substr(op->>'value', position(',' in (op->>'value')) + 1))::jsonb ->> 'currentTotalShares') ELSE NULL END,
        '0x0'
      )
    ) FROM jsonb_array_elements(data->'operators'->'entries') AS e(op) WHERE (op->'key'->>0) = '3' LIMIT 1
  )) / 1e18 ELSE NULL END AS operator_3_share_price_tokens,

  -- counts
  COALESCE((data->'operators'->>'count')::INTEGER, 0) AS operator_count,
  COALESCE((data->'deposits'->>'count')::INTEGER, 0) AS deposits_count,
  COALESCE((data->'withdrawals'->>'count')::INTEGER, 0) AS withdrawals_count,
  COALESCE((data->'successfulBundles'->>'count')::INTEGER, 0) AS bundles_count

FROM epochs
ORDER BY epoch;

CREATE INDEX IF NOT EXISTS idx_comprehensive_datetime ON comprehensive_analytics(epoch_datetime);
CREATE INDEX IF NOT EXISTS idx_comprehensive_date ON comprehensive_analytics(epoch_date);
CREATE INDEX IF NOT EXISTS idx_comprehensive_stake ON comprehensive_analytics(total_stake_tokens);

REFRESH MATERIALIZED VIEW comprehensive_analytics;

COMMIT;


