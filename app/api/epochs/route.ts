import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(){
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key){
    return new Response(JSON.stringify({ error: 'Supabase env vars are missing' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Prefer analytics view; fallback to base epochs table
  let data: any[] | null = null;
  let errMsg: string | null = null;

  // Try comprehensive_analytics first
  {
    const { data: rows, error } = await supabase
      .from('comprehensive_analytics')
      .select('*')
      .order('epoch', { ascending: true });
    if (!error && rows){
      data = rows;
    } else {
      errMsg = error?.message || 'unknown error';
    }
  }

  if (!data){
    const { data: rows, error } = await supabase
      .from('epochs')
      .select('epoch,end_block,end_hash,timestamp,data')
      .order('epoch', { ascending: true });
    if (error){
      return new Response(JSON.stringify({ error: error.message, prior: errMsg }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    data = rows ?? [];
  }

  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}


