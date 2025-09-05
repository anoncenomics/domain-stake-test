import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

export async function GET(req: Request){
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key){
    return new Response(JSON.stringify({ error: 'missing supabase env' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  let limit = 1;
  try { const u = new URL(req.url); const lim = u.searchParams.get('limit'); if (lim) limit = Math.min(Math.max(parseInt(lim,10)||1,1), 100); } catch {}
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('epochs')
    .select('epoch,data')
    .order('epoch', { ascending: false })
    .limit(limit);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(data || []), { headers: { 'content-type': 'application/json' } });
}


