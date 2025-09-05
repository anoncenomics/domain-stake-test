DROP TABLE IF EXISTS epochs_flat;

CREATE TABLE epochs_flat AS
SELECT
  epoch,
  end_block,
  end_hash,
  timestamp,
  json_extract(data, '$.accumulatedTreasuryFunds')                  AS accumulated_treasury_funds,
  json_extract(data, '$.domainChainRewards')                         AS domain_chain_rewards,
  json_extract(data, '$.totalStorageFeeDeposit')                     AS total_storage_fee_deposit,
  json_extract(data, '$.totalStake')                                 AS total_stake,
  json_extract(data, '$.totalShares')                                AS total_shares,
  json_extract(data, '$.pendingStakingOperationCount')               AS pending_staking_operation_count,
  json_extract(data, '$.headDomainNumber')                           AS head_domain_number,
  json_extract(data, '$.headReceiptNumber')                          AS head_receipt_number,
  json_extract(data, '$.newAddedHeadReceipt')                        AS new_added_head_receipt,
  json_extract(data, '$.deposits.count')                             AS deposits_count,
  json_extract(data, '$.withdrawals.count')                          AS withdrawals_count,
  json_extract(data, '$.depositOnHold.count')                        AS deposit_on_hold_count,
  json_extract(data, '$.successfulBundles.count')                    AS successful_bundles_count,
  json_extract(data, '$.operatorEpochSharePrice.count')              AS operator_epoch_share_price_count,
  json_extract(data, '$.operatorHighestSlot.count')                  AS operator_highest_slot_count,
  json_extract(data, '$.operatorBundleSlot.count')                   AS operator_bundle_slot_count,
  json_extract(data, '$.pendingSlashes.count')                       AS pending_slashes_count,
  json_extract(data, '$.lastEpochStakingDistribution.count')         AS last_epoch_staking_distribution_count,
  json_extract(data, '$.invalidBundleAuthors.count')                 AS invalid_bundle_authors_count,
  json_extract(data, '$.latestConfirmedDomainExecutionReceipt.count') AS latest_confirmed_der_count,
  json_extract(data, '$.domainGenesisBlockExecutionReceipt.count')   AS genesis_der_count,
  json_extract(data, '$.latestSubmittedER.count')                    AS latest_submitted_er_count,
  json_extract(data, '$.operators.count')                            AS operators_count
FROM epochs;

CREATE INDEX IF NOT EXISTS idx_epochs_flat_epoch ON epochs_flat(epoch);


