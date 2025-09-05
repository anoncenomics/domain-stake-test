import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0; // ensure no Next.js data cache for this route

function toStringSafe(v: any): string { 
  return v == null ? '0' : String(v); 
}

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

  // Fallback to local file if no database connection
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

  // Parse query parameters
  let limit: number | null = null;
  let sampleSize: number | null = null;
  
  try {
    const u = new URL(req.url);
    
    // Limit parameter
    const lim = u.searchParams.get('limit');
    if (lim && lim.toLowerCase() !== 'all'){
      const n = parseInt(lim, 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, 5000);
    }
    
    // Sample parameter
    const s = u.searchParams.get('sample');
    if (s){
      const n = parseInt(s, 10);
      if (Number.isFinite(n) && n > 0) sampleSize = Math.min(n, 20000);
    }
    
    // Health endpoint
    if (u.searchParams.get('health') === '1'){
      const { data, error } = await supabase
        .from('comprehensive_analytics')
        .select('epoch,operator_0_rewards_tokens,operator_1_rewards_tokens,operator_2_rewards_tokens,operator_3_rewards_tokens')
        .order('epoch', { ascending: false })
        .limit(500);
      
      if (error) throw error;
      
      const rewardsAvailable = (data||[]).filter(r => 
        Number(r.operator_0_rewards_tokens||0) +
        Number(r.operator_1_rewards_tokens||0) +
        Number(r.operator_2_rewards_tokens||0) +
        Number(r.operator_3_rewards_tokens||0) > 0
      ).length;
      
      // Check normalized table availability
      const { data: priceData } = await supabase
        .from('operator_share_prices')
        .select('epoch')
        .gte('epoch', Math.max(0, ((data||[])[0]?.epoch || 0) - 500))
        .limit(1);
      
      return new Response(JSON.stringify({ 
        sample: (data||[]).length, 
        rewardsAvailable,
        normalizedDataAvailable: Boolean(priceData?.length)
      }), { 
        headers: { 'content-type': 'application/json' } 
      });
    }
  } catch {}

  // Main data fetching logic
  const all: any[] = [];
  
  // Select columns from comprehensive_analytics
  const selectCols = 'epoch,end_block,timestamp,total_stake_raw,total_stake_tokens,total_shares_raw,storage_fee_fund_tokens,network_share_price_ratio,operator_count,' +
    'operator_0_stake_tokens,operator_1_stake_tokens,operator_2_stake_tokens,operator_3_stake_tokens,' +
    'operator_0_rewards_tokens,operator_1_rewards_tokens,operator_2_rewards_tokens,operator_3_rewards_tokens,' +
    'operator_share_prices_json,operator_shares_json';

  if (limit) {
    // Fast path: only last N rows
    const { data: rows, error } = await supabase
      .from('comprehensive_analytics')
      .select(selectCols)
      .order('epoch', { ascending: false })
      .limit(limit);
    
    if (error) {
      const fallbackRows = await fallbackFromLocal(limit, sampleSize);
      return new Response(JSON.stringify(fallbackRows), { headers: { 'content-type': 'application/json' } });
    }
    
    if (rows && rows.length) all.push(...rows.slice().reverse());
  } else {
    // Full scan with pagination
    const pageSize = 1000;
    let from = 0;
    
    for (;;) {
      const { data: rows, error } = await supabase
        .from('comprehensive_analytics')
        .select(selectCols)
        .order('epoch', { ascending: true })
        .range(from, from + pageSize - 1);
      
      if (error) {
        const fallbackRows = await fallbackFromLocal(null, null);
        return new Response(JSON.stringify(fallbackRows), { headers: { 'content-type': 'application/json' } });
      }
      
      if (!rows || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  // Apply sampling if requested
  if (sampleSize && all.length > sampleSize){
    const step = Math.ceil(all.length / sampleSize);
    const sampled: any[] = [];
    for (let i = 0; i < all.length; i += step) sampled.push(all[i]);
    if (sampled[sampled.length - 1] !== all[all.length - 1]) sampled.push(all[all.length - 1]);
    all.length = 0;
    all.push(...sampled);
  }

  // For large queries, fetch normalized share prices separately if not in view
  let epochToSharePrices: Record<number, Record<string, string>> = {};
  
  if (all.length > 0 && !all[0].operator_share_prices_json) {
    // If the view doesn't have the JSON columns yet, fetch from normalized tables
    const minEpoch = all[0].epoch;
    const maxEpoch = all[all.length - 1].epoch;
    
    const { data: priceData } = await supabase
      .from('operator_share_prices')
      .select('epoch, operator_id, share_price_perq')
      .gte('epoch', minEpoch)
      .lte('epoch', maxEpoch)
      .in('operator_id', [0, 1, 2, 3]);
    
    if (priceData) {
      for (const row of priceData) {
        if (!epochToSharePrices[row.epoch]) {
          epochToSharePrices[row.epoch] = {};
        }
        epochToSharePrices[row.epoch][String(row.operator_id)] = row.share_price_perq;
      }
    }
  }

  // Map to legacy JSON shape expected by the frontend
  const mapped = all.map((r) => {
    const stakes: Record<string, string> = {};
    const rewards: Record<string, string> = {};
    let sharePrices: Record<string, string> = {};
    
    // Storage fee fund
    const storageFeeTokensVal = r.storage_fee_fund_tokens ?? 0;
    
    // Stakes and rewards from view
    const stakeTokens = [
      r.operator_0_stake_tokens ?? 0,
      r.operator_1_stake_tokens ?? 0,
      r.operator_2_stake_tokens ?? 0,
      r.operator_3_stake_tokens ?? 0
    ];
    const rewardsTokens = [
      r.operator_0_rewards_tokens ?? 0,
      r.operator_1_rewards_tokens ?? 0,
      r.operator_2_rewards_tokens ?? 0,
      r.operator_3_rewards_tokens ?? 0
    ];
    
    for (let i = 0; i < 4; i++) {
      const id = String(i);
      if (stakeTokens[i] != null) stakes[id] = tokensToShannonsString(stakeTokens[i]);
      if (rewardsTokens[i] != null) rewards[id] = tokensToShannonsString(rewardsTokens[i]);
    }
    
    // Share prices from normalized data
    if (r.operator_share_prices_json) {
      // Use data from the view if available
      sharePrices = r.operator_share_prices_json;
    } else if (epochToSharePrices[r.epoch]) {
      // Use separately fetched data
      sharePrices = epochToSharePrices[r.epoch];
    } else {
      // Fallback to network ratio or default
      const networkRatio = r.network_share_price_ratio;
      if (networkRatio != null) {
        const scaled = tokensToShannonsString(networkRatio);
        for (let i = 0; i < 4; i++) sharePrices[String(i)] = scaled;
      } else {
        const defaultSharePrice = (BigInt(1) * (BigInt(10) ** BigInt(18))).toString();
        for (let i = 0; i < 4; i++){
          sharePrices[String(i)] = defaultSharePrice;
        }
      }
    }
    
    // Ensure stable keys 0..3 always exist
    for (let i = 0; i < 4; i++){
      const id = String(i);
      if (!(id in rewards)) rewards[id] = '0';
      if (!(id in sharePrices)) sharePrices[id] = (BigInt(1) * (10n ** 18n)).toString();
    }

    return {
      domainId: 0,
      epoch: r.epoch,
      endBlock: r.end_block,
      endHash: undefined,
      timestamp: r.timestamp,
      totalStake: r.total_stake_raw ? toStringSafe(r.total_stake_raw) : toStringSafe(r.total_stake_tokens ? BigInt(tokensToShannonsString(r.total_stake_tokens)) : 0),
      storageFees: tokensToShannonsString(storageFeeTokensVal),
      operatorStakes: stakes,
      rewards: rewards,
      operatorSharePrices: sharePrices,
      operators: r.operator_count,
      meta: {
        rewardsHasAny: Object.values(rewards).some(v => v !== '0'),
        sharePricesHasAny: Object.values(sharePrices).some(v => v !== '0'),
        sampleApplied: Boolean(sampleSize),
        normalizedData: Boolean(r.operator_share_prices_json || epochToSharePrices[r.epoch]),
        v2: true  // Mark this as v2 API response
      },
      debug: {
        sharesJson: r.operator_shares_json,
        totalSharesRaw: r.total_shares_raw ?? null,
        networkRatioRaw: r.network_share_price_ratio ?? null
      }
    };
  });

  return new Response(JSON.stringify(mapped), { 
    headers: { 
      'content-type': 'application/json',
      'cache-control': 'no-store, max-age=0, must-revalidate',
      'x-api-version': '2.0'  // Version header
    } 
  });
}
