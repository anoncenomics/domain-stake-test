import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0; // ensure no Next.js data cache for this route

function toStringSafe(v: any): string { return v == null ? '0' : String(v); }

function tokensToShannonsString(val: any): string {
  // Convert a decimal tokens value to an integer 1e18-scaled string exactly
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

export async function GET(req: Request){
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  async function fallbackFromLocal(limitParam: number | null, sampleParam: number | null){
    try {
      const file = path.join(process.cwd(), 'public', 'data', 'epochs.json');
      const txt = await fs.readFile(file, 'utf-8');
      const arr = JSON.parse(txt);
      let rows: any[] = Array.isArray(arr) ? arr : [];
      if (limitParam && rows.length > limitParam){
        rows = rows.slice(-limitParam);
      }
      if (sampleParam && rows.length > sampleParam){
        const step = Math.ceil(rows.length / sampleParam);
        const out: any[] = [];
        for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
        if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
        rows = out;
      }
      return rows;
    } catch {
      return [] as any[];
    }
  }

  if (!url || !key){
    const rows = await fallbackFromLocal(null, null);
    return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Optional limit param (?limit=50|200|all)
  let limit: number | null = null;
  try {
    const u = new URL(req.url);
    const lim = u.searchParams.get('limit');
    if (lim && lim.toLowerCase() !== 'all'){
      const n = parseInt(lim, 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, 5000);
    }
  } catch {}

  // Pull rows from comprehensive_analytics (removed non-existent operator_X_shares_raw and operator_X_share_price_tokens columns)
  const selectCols = 'epoch,end_block,timestamp,total_stake_raw,total_stake_tokens,total_shares_raw,storage_fee_fund_tokens,network_share_price_ratio,operator_count,operator_0_stake_tokens,operator_1_stake_tokens,operator_2_stake_tokens,operator_3_stake_tokens,operator_0_rewards_tokens,operator_1_rewards_tokens,operator_2_rewards_tokens,operator_3_rewards_tokens';
  const all: any[] = [];
  let colset: any[] | null = null;
  let sampleSize: number | null = null;
  try {
    const u = new URL(req.url);
    const s = u.searchParams.get('sample');
    if (s){
      const n = parseInt(s, 10);
      if (Number.isFinite(n) && n > 0) sampleSize = Math.min(n, 20000);
    }
  } catch {}
  if (limit){
    // Fast path: only last N rows
    let rows: any[] | null = null;
    let error: any = null;
    try {
      const res = await supabase
        .from('comprehensive_analytics')
        .select(selectCols)
        .order('epoch', { ascending: false })
        .limit(limit);
      rows = res.data as any[] | null;
      error = res.error;
      colset = rows && rows[0] ? Object.keys(rows[0]) : colset;
    } catch {}
    if (error) {
      const res2 = await supabase
        .from('comprehensive_analytics')
        .select('*')
        .order('epoch', { ascending: false })
        .limit(limit);
      rows = res2.data as any[] | null;
      error = res2.error;
      colset = rows && rows[0] ? Object.keys(rows[0]) : colset;
    }
    if (error) {
      const rows = await fallbackFromLocal(limit, sampleSize);
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
    }
    if (rows && rows.length) all.push(...rows.slice().reverse());
  } else {
    // Full scan paged
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      let rows: any[] | null = null;
      let error: any = null;
      try {
        const res = await supabase
          .from('comprehensive_analytics')
          .select(selectCols)
          .order('epoch', { ascending: true })
          .range(from, from + pageSize - 1);
        rows = res.data as any[] | null;
        error = res.error;
        colset = rows && rows[0] ? Object.keys(rows[0]) : colset;
      } catch {}
      if (error) {
        const res2 = await supabase
          .from('comprehensive_analytics')
          .select('*')
          .order('epoch', { ascending: true })
          .range(from, from + pageSize - 1);
        rows = res2.data as any[] | null;
        error = res2.error;
        colset = rows && rows[0] ? Object.keys(rows[0]) : colset;
      }
      if (error) {
        const rows = await fallbackFromLocal(null, null);
        return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
      }
      if (!rows || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  // Optional server-side sampling: reduce to ~sampleSize evenly spaced points (preserve last)
  if (sampleSize && all.length > sampleSize){
    const step = Math.ceil(all.length / sampleSize);
    const sampled: any[] = [];
    for (let i = 0; i < all.length; i += step) sampled.push(all[i]);
    if (sampled[sampled.length - 1] !== all[all.length - 1]) sampled.push(all[all.length - 1]);
    all.length = 0;
    all.push(...sampled);
  }

  // Extract individual operator data from epochs.data JSON
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

  // Build epoch → operator data map from base epochs.data as authoritative source
  async function loadOperatorEpochData(minEpoch: number, maxEpoch: number){
    const epochToData: Record<number, {
      operatorStakes: Record<string, string>;
      operatorShares: Record<string, string>;
      operatorSharePrices: Record<string, string>;
    }> = {};
    
    try {
      const pageSize = 1000;
      let from = 0;
      for (;;) {
        let rows: any[] | null = null;
        let error: any = null;
        try {
          const res = await supabase
            .from('epochs')
            .select('epoch,data')
            .gte('epoch', minEpoch)
            .lte('epoch', maxEpoch)
            .order('epoch', { ascending: true })
            .range(from, from + pageSize - 1);
          rows = res.data as any[] | null;
          error = res.error;
        } catch {}
        if (error) break;
        if (!rows || rows.length === 0) break;
        
        for (const row of rows){
          const epochNum = Number(row.epoch);
          const extractedData = extractOperatorDataFromJSON(row.data);
          if (Object.keys(extractedData.operatorSharePrices).length > 0 || 
              Object.keys(extractedData.operatorStakes).length > 0) {
            epochToData[epochNum] = extractedData;
          }
        }
        
        if (rows.length < pageSize) break;
        from += pageSize;
      }
    } catch {}
    return epochToData;
  }

  let epochDataMap: Record<number, {
    operatorStakes: Record<string, string>;
    operatorShares: Record<string, string>;
    operatorSharePrices: Record<string, string>;
  }> = {};
  if (all.length){
    const minEpoch = Number(all[0].epoch);
    const maxEpoch = Number(all[all.length - 1].epoch);
    epochDataMap = await loadOperatorEpochData(minEpoch, maxEpoch);
  }

  // Map to legacy JSON shape expected by the frontend
  const mapped = all.map((r) => {
    const stakes: Record<string, string> = {};
    const rewards: Record<string, string> = {};
    const sharePrices: Record<string, string> = {};
    // storage fee fund (tokens) may appear under different names depending on view version
    const storageFeeTokensVal = (r as any).storage_fee_fund_tokens ?? (r as any).storage_fees_tokens ?? (r as any).storage_fee_fund ?? (r as any).storage_fees ?? 0;

    const stakeTokens = [
      (r as any).operator_0_stake_tokens ?? (r as any).operator_0_stake ?? 0,
      (r as any).operator_1_stake_tokens ?? (r as any).operator_1_stake ?? 0,
      (r as any).operator_2_stake_tokens ?? (r as any).operator_2_stake ?? 0,
      (r as any).operator_3_stake_tokens ?? (r as any).operator_3_stake ?? 0
    ];
    const rewardsTokens = [
      (r as any).operator_0_rewards_tokens ?? (r as any).operator_0_rewards ?? 0,
      (r as any).operator_1_rewards_tokens ?? (r as any).operator_1_rewards ?? 0,
      (r as any).operator_2_rewards_tokens ?? (r as any).operator_2_rewards ?? 0,
      (r as any).operator_3_rewards_tokens ?? (r as any).operator_3_rewards ?? 0
    ];
    // Note: operator_X_shares_raw and operator_X_share_price_tokens columns don't exist in the database
    const sharesRaw = [0, 0, 0, 0]; // Set to 0 since these columns don't exist
    const networkRatioRaw = (r as any).network_share_price_ratio ?? null;
    const preSharePriceTokens = [null, null, null, null]; // Set to null since these columns don't exist

    // First, try to get data from extracted JSON (authoritative source)
    const epochData = epochDataMap[Number(r.epoch)];
    if (epochData) {
      // Use extracted stakes and share prices from JSON
      Object.assign(stakes, epochData.operatorStakes);
      Object.assign(sharePrices, epochData.operatorSharePrices);
      // Rewards: prefer comprehensive_analytics operator_i_rewards_tokens for stability
      for (let i = 0; i < 4; i++) {
        const id = String(i);
        if (rewardsTokens[i] != null) rewards[id] = tokensToShannonsString(rewardsTokens[i]);
      }
    } else {
      // Fallback to comprehensive_analytics data (if available)
      for (let i = 0; i < 4; i++) {
        const id = String(i);
        if (stakeTokens[i] != null) stakes[id] = tokensToShannonsString(stakeTokens[i]);
        if (rewardsTokens[i] != null) rewards[id] = tokensToShannonsString(rewardsTokens[i]);
      }
    }

    // If no share prices extracted yet, try fallback calculations
    if (Object.keys(sharePrices).length === 0 || Object.values(sharePrices).every(v => !v || v === '0')) {
      // Fallback: if no operator shares data, use network-level ratio when available
      if (networkRatioRaw != null) {
        const scaled = tokensToShannonsString(networkRatioRaw);
        for (let i = 0; i < 4; i++) sharePrices[String(i)] = scaled;
      } else {
        // Final fallback: set share prices to ~1.0 in perquintill scale
        const defaultSharePrice = (BigInt(1) * (BigInt(10) ** BigInt(18))).toString();
        for (let i = 0; i < 4; i++){
          sharePrices[String(i)] = defaultSharePrice;
        }
      }
    }

    return {
      domainId: 0,
      epoch: r.epoch,
      endBlock: r.end_block,
      endHash: undefined,
      timestamp: r.timestamp,
      totalStake: (function(){
        const t = (r as any).total_stake_tokens ?? null;
        if (t != null) return tokensToShannonsString(t);
        return toStringSafe((r as any).total_stake_raw ?? (r as any).total_stake ?? 0);
      })(),
      storageFees: tokensToShannonsString(storageFeeTokensVal),
      operatorStakes: stakes,
      rewards: rewards,
      operatorSharePrices: sharePrices,
      operators: r.operator_count,
      debug: {
        sharesRaw,
        totalSharesRaw: (r as any).total_shares_raw ?? null,
        networkRatioRaw,
        preSharePriceTokens
      }
    };
  });

  return new Response(JSON.stringify(mapped), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0, must-revalidate' } });
}


