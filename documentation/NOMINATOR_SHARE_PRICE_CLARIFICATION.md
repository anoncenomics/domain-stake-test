# Important Discovery: Nominator Share Prices Can Be Below 1.0

## Key Finding

Contrary to our initial understanding, **nominator share prices CAN fall below 1.0**. This is evident in the raw blockchain data where we found ~7 million nominator positions with share prices below 1e18.

## Examples from Blockchain Data

From epoch 1000 `operatorEpochSharePrice.entries`:
```
Position 0: 1000000000000000000 (exactly 1.0)
Position 1: 999999431590008824 (0.9999994316)
Position 2: 999999431482317328 (0.9999994315) 
Position 3: 999999807540699359 (0.9999998075)
Position 4: 999999431178247222 (0.9999994312)
```

## What This Means

1. **Initial Minting**: Shares are minted at 1:1 ratio (share price = 1.0)
2. **Depreciation Possible**: Share prices can decrease below 1.0, likely due to:
   - Operator penalties/slashing
   - Network economic mechanisms
   - Operator tax effects (5% mentioned by user)
3. **Not Just Appreciation**: Nominator positions track both gains AND losses

## Statistics

From our database:
- **6,995,470** nominator positions have share prices < 1.0
- Lowest recorded: **0.996619578** (3.38% loss)
- Most are very close to 1.0 (0.9999+)

## Impact on System Design

### Current Constraint is Wrong
The constraint `CHECK (share_price_perq >= 1000000000000000000)` is incorrect for nominator positions. We should:

1. **Remove the floor constraint** for nominator positions
2. **Keep it only for operators** (they genuinely have a floor of 1.0)
3. **Update our mental model**: Share prices represent actual value changes, including losses

### Operator vs Nominator Differences

**Operators (IDs 0-3)**:
- Floor price: 1.0 (increases with rewards)
- Range in our data: 1.000000 to 1.003392
- Always appreciating (or flat)

**Nominators (IDs > 3)**:
- No floor price (can go below 1.0)
- Range in our data: 0.996620 to 1.000000
- Can depreciate due to various factors

## Hypothesis: Why Nominators Depreciate

1. **Operator Tax**: 5% tax could reduce nominator returns
2. **Slashing Events**: Penalties for operator misbehavior
3. **Economic Mechanisms**: Network fees or other deductions
4. **Time-based Depreciation**: Possible decay mechanism

## Action Items

1. ✅ Document this finding
2. ⏳ Remove incorrect floor constraint for nominators
3. ⏳ Update views to handle sub-1.0 prices correctly
4. ⏳ Investigate correlation between operator performance and nominator depreciation
5. ⏳ Consider showing P&L (profit/loss) for nominator positions in UI

## Code Updates Needed

```sql
-- Remove blanket constraint
ALTER TABLE operator_share_prices 
DROP CONSTRAINT IF EXISTS check_min_share_price;

-- Add operator-specific constraint
ALTER TABLE operator_share_prices 
ADD CONSTRAINT check_operator_min_share_price 
CHECK (
  operator_id > 3 OR share_price_perq >= 1000000000000000000
);
```

This is a significant finding that changes our understanding of the economic model!
