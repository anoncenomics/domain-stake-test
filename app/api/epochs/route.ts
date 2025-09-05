import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

export async function GET(){
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key){
    return new Response(JSON.stringify({ error: 'Supabase env vars are missing' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Pull all rows from comprehensive_analytics in pages (Supabase default max 1000 per request)
  const pageSize = 1000;
  const all: any[] = [];
  let from = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from('comprehensive_analytics')
      .select('epoch,end_block,timestamp,total_stake_raw,operator_count,operator_0_stake_tokens,operator_1_stake_tokens,operator_2_stake_tokens,operator_3_stake_tokens,operator_0_rewards_tokens,operator_1_rewards_tokens,operator_2_rewards_tokens,operator_3_rewards_tokens,operator_0_shares_raw,operator_1_shares_raw,operator_2_shares_raw,operator_3_shares_raw')
      .order('epoch', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  // Map to legacy JSON shape expected by the frontend
  const mapped = all.map((r) => {
    const stakes: Record<string, string> = {};
    const rewards: Record<string, string> = {};
    const sharePrices: Record<string, string> = {};

    const stakeTokens = [r.operator_0_stake_tokens, r.operator_1_stake_tokens, r.operator_2_stake_tokens, r.operator_3_stake_tokens];
    const rewardsTokens = [r.operator_0_rewards_tokens, r.operator_1_rewards_tokens, r.operator_2_rewards_tokens, r.operator_3_rewards_tokens];
    const sharesRaw = [r.operator_0_shares_raw, r.operator_1_shares_raw, r.operator_2_shares_raw, r.operator_3_shares_raw];

    for (let i = 0; i < 4; i++) {
      const id = String(i);
      if (stakeTokens[i] != null) stakes[id] = tokensToShannonsString(stakeTokens[i]);
      if (rewardsTokens[i] != null) rewards[id] = tokensToShannonsString(rewardsTokens[i]);
      try {
        const stakeShannons = BigInt(tokensToShannonsString(stakeTokens[i] ?? 0));
        const shares = BigInt(toStringSafe(sharesRaw[i] ?? '0'));
        if (shares > 0n) {
          // perquintill-style: (stake_shannons * 1e18) / shares
          const pq = (stakeShannons * (10n ** 18n)) / shares;
          sharePrices[id] = pq.toString();
        } else {
          sharePrices[id] = '0';
        }
      } catch { sharePrices[id] = '0'; }
    }

    return {
      domainId: 0,
      epoch: r.epoch,
      endBlock: r.end_block,
      endHash: undefined,
      timestamp: r.timestamp,
      totalStake: toStringSafe(r.total_stake_raw),
      operatorStakes: stakes,
      rewards: rewards,
      operatorSharePrices: sharePrices,
      operators: r.operator_count
    };
  });

  return new Response(JSON.stringify(mapped), { headers: { 'content-type': 'application/json' } });
}


