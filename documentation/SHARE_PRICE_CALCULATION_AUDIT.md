# Share Price Calculation Audit

## Root Cause Analysis

### Current State: All Calculations Are Correct ✅

After auditing the codebase, I've found that **all current share price calculations use the correct formula**: `stake / shares * 1e18`

### Locations Verified:

1. **scripts/enhanced-backfill-with-normalization.mjs** (Line 169)
   ```javascript
   const sharePrice = (stake * BigInt(10 ** 18)) / shares;
   ```
   ✅ Correct: stake/shares

2. **scripts/fix-share-price-calculation.mjs** (Lines 53, 90)
   ```sql
   (os.stake_raw::NUMERIC * 1e18 / os.shares_raw::NUMERIC)
   ```
   ✅ Correct: stake/shares

3. **app/api/epochs/route.ts** (Line 223)
   ```typescript
   const sharePrice = (stake * (10n ** 18n)) / shares;
   ```
   ✅ Correct: stake/shares

4. **SQL Views** (comprehensive_analytics, etc.)
   ```sql
   parse_comma_number(e.data->'domainStakingSummary'->>'currentTotalStake') / 
   COALESCE((e.data->>'totalShares')::NUMERIC, 1)
   ```
   ✅ Correct: stake/shares for network ratio

## Why the Confusion?

The issue wasn't in our calculation code - it was in understanding the data:

1. **Source Data Already at 1.0**: The `operatorEpochSharePrice.entries` in the raw JSON already contains share prices of ~1.0 for nominator positions
2. **Nominator vs Operator**: We were treating nominator positions as operators, leading to confusion about the data
3. **Network Share Price Ratio**: This field in comprehensive_analytics shows stake/shares correctly but might have been misinterpreted

## Calculation Clarity Going Forward

### For Operators (IDs 0-3):
```
Share Price = Stake / Shares * 1e18
- Floor: 1.0 (1e18 in perquintill)
- Grows as rewards accumulate
- Currently showing correct values (1.000xxx)
```

### For Nominators (IDs > 3):
```
Share Price = 1.0 until withdrawal
- Always mints at 1:1 ratio on deposit
- Price calculated only upon withdrawal
- Most show 1.0 because not withdrawn yet
```

### Network Share Price Ratio:
```
Network Ratio = Total Stake / Total Shares
- Aggregate measure across all operators
- Used as fallback when operator-specific data unavailable
```

## Recommendations to Prevent Future Confusion

1. **Rename the `network_share_price_ratio` column** to `network_stake_shares_ratio` to be explicit

2. **Add comments in code** wherever share prices are calculated:
   ```javascript
   // Share price formula: stake/shares * 1e18
   // Floor is 1.0, increases with rewards
   ```

3. **Document the difference** between:
   - Operator share prices (calculated from stake/shares)
   - Nominator share prices (1.0 until withdrawal)
   - Network ratio (aggregate stake/shares)

4. **Create validation checks**:
   ```sql
   -- Share prices should never be below 1.0
   ALTER TABLE operator_share_prices 
   ADD CONSTRAINT check_min_share_price 
   CHECK (share_price_perq >= 1000000000000000000);
   ```

## Operator Tax Consideration

The 5% operator tax mentioned might affect:
- Reward distribution calculations
- Net returns for nominators
- Could be stored in a separate field we haven't identified yet

Worth investigating if we see any 0.95x factors in calculations.

## Conclusion

The calculation logic is correct throughout the codebase. The confusion arose from:
1. Misidentifying nominator positions as operators
2. Not understanding that nominator prices remain at 1.0 until withdrawal
3. Potentially conflating network ratio with individual operator prices

No code changes needed for calculation logic - only labeling and documentation improvements.
