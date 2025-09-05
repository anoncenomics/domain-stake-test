import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

function toStringSafe(v: any): string { return v == null ? '0' : String(v); }

function tokensToShannonsString(val: any): string {
  if (val == null) return '0';
  const s = String(val);
  if (!s.includes('.')) return (BigInt(s) * (10n ** 18n)).toString();
  const [intPart, fracPartRaw] = s.split('.');
  const frac = (fracPartRaw || '').replace(/[^0-9]/g, '');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  const i = BigInt(intPart || '0') * (10n ** 18n);
  const f = BigInt(fracPadded);
  return (i + f).toString();
}

export async function GET(){
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key){
    return new Response(JSON.stringify({ error: 'Supabase env vars are missing' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Grab the latest row only (removed operator_X_shares_raw columns that don't exist)
  const { data, error } = await supabase
    .from('comprehensive_analytics')
    .select('epoch,end_block,timestamp,total_stake_raw,storage_fee_fund_tokens,operator_0_stake_tokens,operator_1_stake_tokens,operator_2_stake_tokens,operator_3_stake_tokens,operator_0_rewards_tokens,operator_1_rewards_tokens,operator_2_rewards_tokens,operator_3_rewards_tokens,network_share_price_ratio')
    .order('epoch', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  if (!data){
    return new Response(JSON.stringify(null), { headers: { 'content-type': 'application/json' } });
  }

  const row: any = data;
  const storageFeeTokensVal = row.storage_fee_fund_tokens ?? 0;
  const stakeTokens = [row.operator_0_stake_tokens ?? 0, row.operator_1_stake_tokens ?? 0, row.operator_2_stake_tokens ?? 0, row.operator_3_stake_tokens ?? 0];
  const rewardsTokens = [row.operator_0_rewards_tokens ?? 0, row.operator_1_rewards_tokens ?? 0, row.operator_2_rewards_tokens ?? 0, row.operator_3_rewards_tokens ?? 0];
  const networkRatio = row.network_share_price_ratio ?? null;

  let rewardsTotal = 0;
  try { rewardsTotal = rewardsTokens.reduce((a: number, b: number)=> a + (Number(b)||0), 0); } catch {}

  // Extract individual operator data from the latest epoch's JSON
  const operatorSharePrices: Record<string, string> = {};
  
  // Get the latest epoch's JSON data to extract real operator share prices
  try {
    const { data: latestEpoch, error: epochError } = await supabase
      .from('epochs')
      .select('epoch,data')
      .order('epoch', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (!epochError && latestEpoch) {
      // Extract share prices from the JSON using the same logic as epochs route
      const extractedData = extractOperatorDataFromJSON(latestEpoch.data);
      Object.assign(operatorSharePrices, extractedData.operatorSharePrices);
    }
  } catch {
    // Continue with fallback logic
  }
  
  // Fallback logic if extraction failed
  if (Object.keys(operatorSharePrices).length === 0) {
    if (networkRatio != null) {
      const networkSharePriceShannons = tokensToShannonsString(networkRatio);
      for (let i = 0; i < 4; i++){
        operatorSharePrices[String(i)] = networkSharePriceShannons;
      }
    } else {
      // Final fallback: set share prices to ~1.0 in perquintill scale
      const defaultSharePrice = (BigInt(1) * (BigInt(10) ** BigInt(18))).toString();
      for (let i = 0; i < 4; i++){
        operatorSharePrices[String(i)] = defaultSharePrice;
      }
    }
  }

  // Helper function to extract operator data from JSON (same as epochs route)
  function extractOperatorDataFromJSON(data: any): {
    operatorStakes: Record<string, string>;
    operatorShares: Record<string, string>;
    operatorSharePrices: Record<string, string>;
  } {
    const operatorStakes: Record<string, string> = {};
    const operatorShares: Record<string, string> = {};
    const operatorSharePrices: Record<string, string> = {};

    // Extract individual operator stakes and shares from operators.entries
    if (data?.operators?.entries && Array.isArray(data.operators.entries)) {
      for (const entry of data.operators.entries) {
        try {
          const opId = entry.key?.[0] || entry.key;
          if (opId === undefined) continue;

          const valueStr = entry.value;
          if (typeof valueStr !== 'string') continue;

          // Parse the complex format: "hex_prefix,{json_data}"
          const commaIndex = valueStr.indexOf(',');
          if (commaIndex === -1) continue;

          const jsonPart = valueStr.slice(commaIndex + 1);
          const operatorData = JSON.parse(jsonPart);

          // Extract stake and shares (both are hex values)
          if (operatorData.currentTotalStake) {
            operatorStakes[String(opId)] = BigInt(operatorData.currentTotalStake).toString();
          }
          if (operatorData.currentTotalShares) {
            operatorShares[String(opId)] = BigInt(operatorData.currentTotalShares).toString();
          }
        } catch {
          // Skip invalid entries
        }
      }
    }

    // Calculate share prices from stake/shares ratio (primary method)
    for (const [opId, stakeStr] of Object.entries(operatorStakes)) {
      const sharesStr = operatorShares[opId];
      if (stakeStr && sharesStr) {
        try {
          const stake = BigInt(stakeStr);
          const shares = BigInt(sharesStr);
          if (shares > 0n) {
            // Calculate share price as stake/shares in perquintill scale (1e18)
            const sharePrice = (stake * (10n ** 18n)) / shares;
            operatorSharePrices[opId] = sharePrice.toString();
          }
        } catch {
          // Skip calculation errors
        }
      }
    }

    // Fallback: Extract share prices from operatorEpochSharePrice.entries if no calculated prices
    if (Object.keys(operatorSharePrices).length === 0 && data?.operatorEpochSharePrice?.entries && Array.isArray(data.operatorEpochSharePrice.entries)) {
      const latestByOp: Record<string, string> = {};
      
      for (const entry of data.operatorEpochSharePrice.entries) {
        try {
          const opId = entry.key?.[0] || entry.key;
          if (opId === undefined) continue;

          const valueStr = entry.value;
          if (typeof valueStr !== 'string') continue;

          // Parse format: "hex_data,decimal_value"
          const commaIndex = valueStr.lastIndexOf(',');
          if (commaIndex === -1) continue;

          const decimalValue = valueStr.slice(commaIndex + 1);
          if (decimalValue && !isNaN(Number(decimalValue))) {
            // Keep the latest/highest share price for this operator
            if (!latestByOp[String(opId)] || Number(decimalValue) > Number(latestByOp[String(opId)])) {
              latestByOp[String(opId)] = decimalValue;
            }
          }
        } catch {
          // Skip invalid entries
        }
      }

      // Use extracted share prices as fallback
      Object.assign(operatorSharePrices, latestByOp);
    }

    return { operatorStakes, operatorShares, operatorSharePrices };
  }

  const out = {
    epoch: row.epoch,
    endBlock: row.end_block,
    timestamp: row.timestamp,
    totalStake: toStringSafe(row.total_stake_raw ?? 0),
    storageFees: tokensToShannonsString(storageFeeTokensVal),
    rewardsTotal: tokensToShannonsString(rewardsTotal),
    operatorSharePrices
  };

  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0, must-revalidate' } });
}


