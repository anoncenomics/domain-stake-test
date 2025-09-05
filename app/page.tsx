'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ComposedChart, Bar, Brush } from 'recharts';

function useEpochs(limit: '50' | '100' | '200' | 'All' = '100'){
  const [data, setData] = useState<any[]>([]);
  useEffect(() => {
    const qp = limit === 'All' ? 'all' : limit;
    fetch(`/api/epochs?limit=${encodeURIComponent(String(qp))}`)
      .then(r => r.json())
      .then((rows) => Array.isArray(rows) ? setData(rows) : setData([]))
      .catch(()=>setData([]));
  }, [limit]);
  return data;
}

function formatBig(x?: string){
  if (!x) return '';
  try {
    const n = BigInt(x);
    // format with thousands separators only, no suffixes
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } catch {
    return String(x);
  }
}

function insertThousandsSeparators(intStr: string){
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pow10BigInt(exp: number){
  let result = BigInt(1);
  for (let i = 0; i < exp; i++) result *= BigInt(10);
  return result;
}

function formatTokensFromShannons(x?: string, fractionDigits = 3){
  if (!x) return '';
  try {
    const value = BigInt(x);
    const base = pow10BigInt(18);
    const integer = value / base;
    const remainder = value % base;
    const scale = pow10BigInt(fractionDigits);
    // round half up
    let fractional = (remainder * scale + base / BigInt(2)) / base;
    let carry = BigInt(0);
    const limit = scale;
    if (fractional >= limit) { fractional -= limit; carry = BigInt(1); }
    const intStr = insertThousandsSeparators((integer + carry).toString());
    const fracStr = fractional.toString().padStart(fractionDigits, '0');
    return `${intStr}.${fracStr}`;
  } catch {
    return '';
  }
}

function tokensPlainFromShannons(x?: string, fractionDigits = 3){
  if (!x) return '';
  try {
    const value = BigInt(x);
    const base = pow10BigInt(18);
    const integer = value / base;
    const remainder = value % base;
    const scale = pow10BigInt(fractionDigits);
    // round half up
    let fractional = (remainder * scale + base / BigInt(2)) / base;
    let carry = BigInt(0);
    const limit = scale;
    if (fractional >= limit) { fractional -= limit; carry = BigInt(1); }
    const intStr = (integer + carry).toString();
    const fracStr = fractional.toString().padStart(fractionDigits, '0');
    return `${intStr}.${fracStr}`;
  } catch {
    return '';
  }
}

function tokensNumberFromShannons(x?: string, fractionDigits = 6){
  const plain = tokensPlainFromShannons(x, fractionDigits);
  return plain ? parseFloat(plain) : 0;
}

function perquintillToNumber(x?: string){
  // Perquintill uses 1e18 scale, reuse token formatter with 18 fraction digits
  const plain = tokensPlainFromShannons(x, 18);
  return plain ? parseFloat(plain) : 0;
}

function deltaBps(curr?: string, prev?: string){
  try {
    if (!curr || !prev) return 0;
    const c = BigInt(curr);
    const p = BigInt(prev);
    if (p === BigInt(0)) return 0;
    const diff = c - p; // same scale, cancels in division
    const bps = (diff * BigInt(10000)) / p;
    return Number(bps);
  } catch {
    return 0;
  }
}

function formatPerquintillDecimalString(x?: string){
  // Return a long decimal string with up to 18 fractional digits; trim trailing zeros
  const s = tokensPlainFromShannons(x, 18);
  if (!s) return '';
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function ratioToFixed(numer?: string, denom?: string, fractionDigits = 6){
  try {
    if (!numer || !denom) return '';
    const n = BigInt(numer);
    const d = BigInt(denom);
    if (d === BigInt(0)) return '';
    const scale = pow10BigInt(fractionDigits);
    const q = (n * scale) / d; // floor
    const intPart = q / scale;
    const fracPart = q % scale;
    return `${intPart.toString()}.${fracPart.toString().padStart(fractionDigits, '0')}`;
  } catch {
    return '';
  }
}

function formatAmount(x: string | undefined, unit: 'AI3' | 'Shannons'){
  return unit === 'AI3' ? formatTokensFromShannons(x, 3) : formatBig(x);
}

function formatRewardsAmount(x: string | undefined, unit: 'AI3' | 'Shannons'){
  return unit === 'AI3' ? formatTokensFromShannons(x, 6) : formatBig(x);
}

function formatTokensIntegerFromShannons(x?: string){
  if (!x) return '';
  try {
    const value = BigInt(x);
    const base = pow10BigInt(18);
    const integer = value / base;
    return insertThousandsSeparators(integer.toString());
  } catch {
    return '';
  }
}

function formatYAxisTick(v: number, unit: 'AI3' | 'Shannons'){
  if (unit === 'Shannons'){
    if (!Number.isFinite(v)) return '';
    if (v === 0) return '0';
    // Reduce mantissa decimals as much as reasonable (trim trailing zeros)
    const str = Number(v).toExponential(3).replace('e+', 'e');
    const [mantissa, exp] = str.split('e');
    let m = mantissa;
    if (m.includes('.')){
      m = m.replace(/0+$/, ''); // drop trailing zeros
      m = m.replace(/\.$/, ''); // drop trailing dot if any
    }
    return `${m}e${exp}`;
  }
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(v);
}

function formatTooltipNumber(v: number, unit: 'AI3' | 'Shannons', kind: 'stake' | 'rewards'){
  if (kind === 'stake'){
    // Whole numbers for stake
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
  }
  // Rewards: adaptive 3-7 significant non-zero decimals for AI3, plain for Shannons
  if (unit === 'Shannons'){
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
  }
  // AI3 rewards
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  // Determine decimals: at least 3, at most 7, but extend until 3 non-zero decimals or cap
  let decimals = 3;
  const toFixedAt = (d: number) => Number(v).toFixed(d);
  if (abs > 0){
    for (let d = 3; d <= 7; d++){
      const s = toFixedAt(d);
      const frac = s.split('.')[1] || '';
      const nonZero = (frac.match(/[^0]/g) || []).length;
      if (nonZero >= 3 || d === 7){
        decimals = d;
        break;
      }
    }
  }
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
}

class ChartErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; errorMsg?: string }>{
  constructor(props: any){
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: any){
    return { hasError: true, errorMsg: error?.message || String(error) };
  }
  componentDidCatch(error: any, info: any){
    try { console.error('Chart render error', error, info); } catch {}
  }
  render(){
    if (this.state.hasError){
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px', color: '#EF4444', background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 12 }}>
          <span style={{ fontSize: 12 }}>Chart failed to render. Try changing settings or reloading.</span>
        </div>
      );
    }
    return this.props.children as any;
  }
}

function LiveAgo({ lastLiveAt }: { lastLiveAt: number }){
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor(((now - lastLiveAt) / 1000)));
  return (
    <span style={{ fontSize: '11px', color: '#6b7280', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif' }}>
      {secs}s ago
    </span>
  );
}

function DashboardHeader({ isLive, liveStatus, lastLiveAt, setIsLive, setLiveStatus, onDownloadCSV, isMobile }: { 
  isLive: boolean; 
  liveStatus: 'idle' | 'connecting' | 'live' | 'error'; 
  lastLiveAt: number | null; 
  setIsLive: (v: boolean) => void; 
  setLiveStatus: (v: 'idle' | 'connecting' | 'live' | 'error') => void; 
  onDownloadCSV: () => void; 
  isMobile: boolean 
}){
  const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif';
  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'space-between', 
      marginBottom: isMobile ? '16px' : '20px',
      fontFamily 
    }}>
      <div>
        <h1 style={{ 
          fontSize: isMobile ? '18px' : '24px', 
          fontWeight: 600, 
          color: '#111827', 
          margin: 0, 
          lineHeight: 1.2,
          fontFamily 
        }}>
          Auto EVM (domain 0)
        </h1>
        <p style={{ 
          fontSize: isMobile ? '13px' : '14px', 
          color: '#64748b', 
          margin: '2px 0 0 0',
          fontFamily 
        }}>
          Epoch Staking & Rewards
        </p>
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '8px' : '12px' }}>
        {/* Live Status & Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            title={liveStatus}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background:
                liveStatus === 'live' ? '#10B981' :
                liveStatus === 'connecting' ? '#F59E0B' :
                liveStatus === 'error' ? '#EF4444' : '#9CA3AF'
            }}
          />
          <button
            onClick={() => {
              const next = !isLive;
              setIsLive(next);
              if (!next) setLiveStatus('idle');
            }}
            style={{ 
              padding: isMobile ? '6px 12px' : '8px 16px',
              fontSize: isMobile ? '12px' : '13px',
              border: '1px solid #d1d5db', 
              borderRadius: '6px', 
              background: isLive ? '#10B981' : 'white',
              color: isLive ? 'white' : '#374151',
              cursor: 'pointer', 
              transition: 'all 0.15s ease-in-out',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
              fontWeight: 500,
              fontFamily
            }}
            onMouseEnter={(e) => {
              if (!isLive) {
                e.currentTarget.style.background = '#f3f4f6';
              }
            }}
            onMouseLeave={(e) => {
              if (!isLive) {
                e.currentTarget.style.background = 'white';
              }
            }}
          >
            Live {isLive ? 'On' : 'Off'}
          </button>
          {isLive && lastLiveAt && (<LiveAgo lastLiveAt={lastLiveAt} />)}
        </div>
        
        {/* Download CSV */}
        <button 
          onClick={onDownloadCSV}
          style={{ 
            padding: isMobile ? '6px 12px' : '8px 16px',
            fontSize: isMobile ? '12px' : '13px',
            border: '1px solid #d1d5db', 
            borderRadius: '6px', 
            background: 'white', 
            color: '#374151',
            cursor: 'pointer', 
            transition: 'all 0.15s ease-in-out',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
            fontWeight: 500,
            fontFamily
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#f3f4f6';
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'white';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
          }}
        >
          Download CSV
        </button>
      </div>
    </div>
  );
}

function DomainSummary({ summary, isMobile }: { summary: any; isMobile: boolean }){
  const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif';
  return (
    <div style={{ 
      background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)', 
      borderRadius: '12px 12px 0 0', 
      border: '2px solid #d1d5db', 
      borderBottom: '1px solid #e2e8f0', 
      padding: isMobile ? '20px' : '24px', 
      fontFamily,
      boxShadow: '0 8px 16px rgba(0, 0, 0, 0.12), 0 4px 6px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
      position: 'relative'
    }}>
      {/* Subtle texture overlay */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'radial-gradient(circle at 20% 80%, rgba(120, 119, 198, 0.03), transparent 50%), radial-gradient(circle at 80% 20%, rgba(255, 255, 255, 0.05), transparent 50%)',
        borderRadius: '12px 12px 0 0',
        pointerEvents: 'none'
      }} />
      
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: isMobile ? 16 : 20, alignItems: 'stretch', position: 'relative', zIndex: 1 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: isMobile ? 12 : 13, color: '#64748b', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily }}>Epoch</div>
          <div style={{ fontSize: isMobile ? 28 : 32, fontWeight: 700, color: '#111827', lineHeight: 1.1, fontFamily, textShadow: '0 1px 2px rgba(0,0,0,0.1)' }}>{summary.lastEpoch}</div>
          <div style={{ fontSize: isMobile ? 11 : 12, color: '#64748b', marginTop: 4, fontFamily }}>Last updated</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: isMobile ? 12 : 13, color: '#64748b', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily }}>Total Stake</div>
          <div style={{ fontSize: isMobile ? 28 : 32, fontWeight: 700, color: '#111827', lineHeight: 1.1, fontFamily, textShadow: '0 1px 2px rgba(0,0,0,0.1)' }}>{summary.totalStake}</div>
          <div style={{ fontSize: isMobile ? 10 : 11, color: '#6b7280', marginTop: 4, fontFamily }}>incl. storage fees: {summary.storageFees}
            <span style={{ color: '#94a3b8' }}> (≈25%)</span>
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: isMobile ? 12 : 13, color: '#64748b', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily }}>Latest Rewards</div>
          <div style={{ fontSize: isMobile ? 28 : 32, fontWeight: 700, color: '#111827', lineHeight: 1.1, fontFamily, textShadow: '0 1px 2px rgba(0,0,0,0.1)' }}>{summary.rewardsTotal}</div>
          <div style={{ fontSize: isMobile ? 11 : 12, color: '#64748b', marginTop: 4, fontFamily }}>AI3</div>
        </div>
      </div>
    </div>
  );
}

function MiniSparkline({ data, color }: { data: number[]; color: string }){
  const w = 120;
  const h = 28;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pad = max === min ? 1 : (max - min) * 0.05;
  const lo = min - pad;
  const hi = max + pad;
  const points = data.map((v, i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h - ((v - lo) / Math.max(1e-9, (hi - lo))) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
    </svg>
  );
}

function OperatorTable({ rows, latest, isMobile }: { rows: any[]; latest: any; isMobile: boolean }){
  const opIds = (latest.latestSharePrices || []).map((r: any) => r.id);
  // Compute common prefix across all visible decimals
  const decimals: string[] = (latest.latestSharePrices || []).map((x: any) => String(x.decimal || ''));
  let commonPrefix = '';
  if (decimals.length >= 2){
    const L = Math.min(...decimals.map(s => s.length));
    let i = 0;
    for (; i < L; i++){
      const ch = decimals[0][i];
      if (!decimals.every(s => s[i] === ch)) break;
    }
    commonPrefix = decimals[0].slice(0, i);
  } else if (decimals.length === 1){
    commonPrefix = decimals[0];
  }

  const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif';
  const monoFamily = '"JetBrains Mono", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  
  const COLORS = {
    total: '#111827',
    op0: '#60A5FA',
    op1: '#F59E0B',
    op2: '#10B981',
    op3: '#EF4444'
  } as const;
  
  return (
    <div style={{ 
      background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)', 
      borderRadius: '0 0 12px 12px', 
      border: '2px solid #d1d5db', 
      borderTop: 'none', 
      overflow: 'hidden',
      boxShadow: '0 8px 16px rgba(0, 0, 0, 0.12), 0 4px 6px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
      padding: isMobile ? '16px' : '20px'
    }}>
      {/* Subtle divider */}
      <div style={{ 
        height: '1px', 
        background: 'linear-gradient(90deg, transparent 0%, #e2e8f0 50%, transparent 100%)', 
        marginBottom: isMobile ? '16px' : '20px' 
      }} />
      
      {/* Operator Cards */}
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(300px, 1fr))', gap: isMobile ? 12 : 16 }}>
          {(opIds as any[]).map((id: any) => {
            const color = id === '0' ? COLORS.op0 : id === '1' ? COLORS.op1 : id === '2' ? COLORS.op2 : COLORS.op3;
            const colorBg = id === '0' ? '#EFF6FF' : id === '1' ? '#FEF3C7' : id === '2' ? '#ECFDF5' : '#FEE2E2';
            const stakes = rows[rows.length - 1]?.operatorStakes || {};
            const rewards = rows[rows.length - 1]?.rewards || {};
            const stakeStr = formatTokensIntegerFromShannons(stakes[id] || '0');
            const rewardStr = formatRewardsAmount(rewards[id] || '0', 'AI3');
            const valueStr = String((latest.latestSharePrices || []).find((x: any)=>x.id===id)?.decimal || '');
            const prefix = valueStr.startsWith(commonPrefix) ? commonPrefix : '';
            const suffix = valueStr.slice(prefix.length);
            const isChecked = true;
            
            return (
              <div key={id} style={{ 
                border: '2px solid #d1d5db',
                borderRadius: '10px',
                padding: isMobile ? '16px' : '20px',
                background: 'linear-gradient(145deg, #ffffff 0%, #fafbfc 100%)',
                borderLeft: `6px solid ${color}`,
                transition: 'all 0.2s ease',
                position: 'relative',
                boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.2)'
              }}>
                {/* Operator Header */}
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between',
                  marginBottom: 12
                }}>
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 8
                  }}>
                    <div style={{ 
                      width: 12, 
                      height: 12, 
                      borderRadius: '50%', 
                      background: color 
                    }} />
                    <h4 style={{ 
                      fontSize: isMobile ? 16 : 18, 
                      fontWeight: 700, 
                      color: '#111827', 
                      margin: 0,
                      fontFamily 
                    }}>
                      Operator {id}
                    </h4>
                  </div>
                  
                  {/* Show/Hide Toggle */}
                  
                </div>

                {/* Stats Grid */}
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', 
                  gap: isMobile ? 12 : 16
                }}>
                  {/* Total Stake */}
                  <div>
                    <div style={{ 
                      fontSize: isMobile ? 11 : 12, 
                      color: '#64748b', 
                      fontWeight: 500, 
                      marginBottom: 4,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      fontFamily 
                    }}>
                      Total Stake
                    </div>
                    <div style={{ 
                      fontSize: isMobile ? 18 : 20, 
                      fontWeight: 700, 
                      color: color, 
                      lineHeight: 1.2,
                      fontFamily 
                    }}>
                      {stakeStr}
                    </div>
                    <div style={{ 
                      fontSize: isMobile ? 10 : 11, 
                      color: '#94a3b8', 
                      fontFamily 
                    }}>
                      AI3
                    </div>
                  </div>

                  {/* Epoch Rewards */}
                  <div>
                    <div style={{ 
                      fontSize: isMobile ? 11 : 12, 
                      color: '#64748b', 
                      fontWeight: 500, 
                      marginBottom: 4,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      fontFamily 
                    }}>
                      Latest Rewards
                    </div>
                    <div style={{ 
                      fontSize: isMobile ? 18 : 20, 
                      fontWeight: 700, 
                      color: '#111827', 
                      lineHeight: 1.2,
                      fontFamily 
                    }}>
                      {rewardStr}
                    </div>
                    <div style={{ 
                      fontSize: isMobile ? 10 : 11, 
                      color: '#94a3b8', 
                      fontFamily 
                    }}>
                      AI3
                    </div>
                  </div>
                </div>

                {/* Share Price */}
                <div style={{ 
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid #f1f5f9'
                }}>
                  <div style={{ 
                    fontSize: isMobile ? 11 : 12, 
                    color: '#64748b', 
                    fontWeight: 500, 
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    fontFamily 
                  }}>
                    Share Price
                  </div>
                  <div style={{ 
                    fontSize: isMobile ? 13 : 14, 
                    fontFamily: monoFamily,
                    color: '#111827',
                    fontWeight: 600,
                    lineHeight: 1.2
                  }} title={'Perquintill'}>
                    <span style={{ color: '#94a3b8' }}>{prefix}</span>
                    <span style={{ color: color }}>{suffix}</span>
                  </div>
                  <div style={{ 
                    fontSize: isMobile ? 10 : 11, 
                    color: '#94a3b8', 
                    fontFamily,
                    marginTop: 2
                  }}>
                    Perquintill
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard(){
  const [range, setRange] = useState<'50' | '100' | '200' | 'All'>('50');
  const rows = useEpochs(range);
  const [allCache, setAllCache] = useState<any[] | null>(null);

  const [isLive, setIsLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [liveRow, setLiveRow] = useState<any | null>(null);
  const [liveBuffer, setLiveBuffer] = useState<any[]>([]);
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);
  useEffect(() => {
    // Prefetch all epochs in the background for instant switch later (sample to 1000 points)
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/epochs?limit=all&sample=1000');
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) setAllCache(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // removed unused tick that caused heartbeat re-renders when live was on

  function mapToObj(m: any){
    if (!m) return {} as Record<string, string>;
    const out: Record<string, string> = {};
    try {
      if (typeof m.entries === 'function'){
        for (const [k, v] of m.entries()){
          const kk = (k?.toNumber?.() ?? Number(k)) as any;
          out[String(kk)] = v?.toString?.() ?? String(v);
        }
        return out;
      }
      const j = m.toJSON?.() ?? m;
      if (j && typeof j === 'object'){
        for (const [k, v] of Object.entries(j as any)){
          if (v && typeof v === 'object' && typeof (v as any).toString === 'function'){
            out[k] = (v as any).toString();
          } else if (typeof v === 'string' && v.startsWith('0x')){
            try { out[k] = BigInt(v as string).toString(); } catch { out[k] = String(v); }
          } else {
            out[k] = String(v);
          }
        }
        return out;
      }
    } catch {}
    return out;
  }

  useEffect(() => {
    if (!isLive) return;
    let unsub: any;
    let apiRef: any = null;
    let disconnected = false;
    let attempt = 0;
    const MAX_DELAY = 30000; // 30s cap
    const connect = async () => {
      setLiveStatus('connecting');
      try {
        const mod = await import('@autonomys/auto-utils');
        const api = await (mod as any).activate({ rpcUrl: 'wss://rpc.mainnet.subspace.foundation/ws' } as any);
        apiRef = api;
        if (disconnected) { try { await api.disconnect(); } catch {} return; }
        setLiveStatus('live');
        attempt = 0; // reset backoff on success
        unsub = await (api as any).rpc.chain.subscribeNewHeads(async (header: any) => {
          try {
            const blockNumber = header.number.toNumber();
            const hash = await (api as any).rpc.chain.getBlockHash(blockNumber);
            const at = await (api as any).at(hash);
            const opt = await (at as any).query.domains.domainStakingSummary(0);
            if (!opt || opt.isNone) return;
            const s = opt.unwrap();
            const epochRaw = s.currentEpochIndex ?? s.epochIndex ?? s.epoch;
            const epoch = typeof epochRaw?.toNumber === 'function' ? epochRaw.toNumber() : Number(epochRaw);
            const totalStake = (s.currentTotalStake ?? s.totalStake)?.toString?.() ?? null;
            const operatorStakes = mapToObj(s.currentOperators);
            const rewards = mapToObj(s.currentEpochRewards);
            // storage fee fallback: estimate at ~25% of total stake when not available
            let storageFees: string | null = null;
            try { if (totalStake) storageFees = (BigInt(totalStake) / BigInt(4)).toString(); } catch {}
            const row = {
              domainId: 0,
              epoch,
              startBlock: undefined,
              endBlock: blockNumber,
              startHash: undefined,
              endHash: hash.toString(),
              totalStake,
              storageFees,
              operatorStakes,
              rewards
            } as any;
            setLiveRow(row);
            setLiveBuffer(prev => {
              if (!prev.length) return [row];
              const last = prev[prev.length - 1];
              if (last && last.epoch === row.epoch) {
                const cp = prev.slice();
                cp[cp.length - 1] = { ...last, ...row };
                return cp;
              }
              const merged = [...prev, row];
              const LIMIT = 5;
              return merged.slice(-LIMIT);
            });
            setLastLiveAt(Date.now());
          } catch {}
        });
      } catch (e) {
        setLiveStatus('error');
        attempt += 1;
        const delay = Math.min(MAX_DELAY, 1000 * Math.pow(2, attempt));
        if (!disconnected) setTimeout(connect, delay);
      }
    };
    connect();
    return () => {
      disconnected = true;
      try { if (typeof unsub === 'function') unsub(); } catch {}
      try { if (apiRef && typeof apiRef.disconnect === 'function') apiRef.disconnect(); } catch {}
    };
  }, [isLive]);

  // No global 1s ticker; LiveAgo handles its own timer to avoid chart heartbeat

  const mergedRows = useMemo(() => {
    const base = Array.isArray(rows) ? rows.slice() : [];
    if (!liveBuffer.length) return base;
    const out = base.slice();
    for (const lr of liveBuffer){
      const last = out[out.length - 1];
      if (!last) { out.push(lr); continue; }
      if (lr.epoch > last.epoch) out.push(lr);
      else if (lr.epoch === last.epoch) out[out.length - 1] = { ...last, ...lr };
    }
    return out;
  }, [rows, liveBuffer]);

  const [unit, setUnit] = useState<'AI3' | 'Shannons'>('AI3');

  const isSummaryLive = useMemo(() => Boolean(isLive && liveRow), [isLive, liveRow]);

  const baseRows = useMemo(() => mergedRows.map((r: any) => ({
    epoch: r.epoch,
    startBlock: r.startBlock,
    endBlock: r.endBlock,
    totalStake: String(r.totalStake ?? '0'),
    storageFees: String(r.storageFees ?? '0'),
    operatorStakes: r.operatorStakes ?? {},
    rewards: r.rewards ?? {},
    operatorSharePrices: r.operatorSharePrices ?? {}
  })), [mergedRows]);

  const summary = useMemo(() => {
    const last: any = mergedRows[mergedRows.length - 1];
    if (!last) {
      return { lastEpoch: '-', totalStake: '-', operators: '-', rewardsTotal: '-', latestSharePrices: [] } as const;
    }
    const operators = Object.keys(last.operatorStakes ?? {}).length;
    const rewardsTotalBig = Object.values(last.rewards ?? {}).reduce((acc: bigint, v: any) => {
      try { return acc + BigInt(v as any); } catch { return acc; }
    }, BigInt(0));
    
    // Latest operator share prices and normalized ratios
    // Live data might not include operatorSharePrices, so fall back to last known static data
    let sp = (last.operatorSharePrices ?? {}) as Record<string, string>;
    
    // If no share prices in current row, find the most recent row that has share prices
    if (Object.keys(sp).length === 0) {
      for (let i = mergedRows.length - 2; i >= 0; i--) {
        const staticRow = mergedRows[i];
        if (staticRow?.operatorSharePrices && Object.keys(staticRow.operatorSharePrices).length > 0) {
          sp = staticRow.operatorSharePrices;
          break;
        }
      }
    }
    
    const opIds = Object.keys(sp).sort((a,b)=>Number(a)-Number(b));
    const values = opIds.map(id => perquintillToNumber(sp[id]) || 0);
    const max = values.length ? Math.max(...values) : 0;
    const min = values.length ? Math.min(...values) : 0;
    const latestSharePrices = opIds.map(id => ({
      id,
      raw: sp[id],
      decimal: formatPerquintillDecimalString(sp[id]),
      // normalize 0..1 across current operator set
      normalized: (function(){
        const v = perquintillToNumber(sp[id]) || 0;
        if (!Number.isFinite(v)) return 0;
        if (max === min) return 1; // degenerate case
        return (v - min) / (max - min);
      })()
    }));
    let totalPlusFees: string = '0';
    try {
      const t = BigInt(String((last as any).totalStake ?? '0'));
      const s = BigInt(String((last as any).storageFees ?? '0'));
      totalPlusFees = (t + s).toString();
    } catch { totalPlusFees = String((last as any).totalStake ?? '0'); }

    return {
      lastEpoch: last.epoch,
      totalStake: unit === 'AI3' ? formatTokensIntegerFromShannons(totalPlusFees) : formatAmount(totalPlusFees, unit),
      storageFees: unit === 'AI3' ? formatTokensIntegerFromShannons(String((last as any).storageFees ?? '0')) : formatAmount(String((last as any).storageFees ?? '0'), unit),
      operators,
      rewardsTotal: formatRewardsAmount(rewardsTotalBig.toString(), unit),
      latestSharePrices
    } as const;
  }, [mergedRows, unit]);

  const [showOp0, setShowOp0] = useState(true);
  const [showOp1, setShowOp1] = useState(true);
  const [showOp2, setShowOp2] = useState(true);
  const [showOp3, setShowOp3] = useState(true);
  const [stakeScale, setStakeScale] = useState<'auto' | 'fit' | 'log'>('auto');
  const [rewardsScale, setRewardsScale] = useState<'auto' | 'fit' | 'log'>('log');
  const [shareScale, setShareScale] = useState<'auto' | 'fit' | 'log'>('auto');
  const [shareView, setShareView] = useState<'abs' | 'delta' | 'index'>('abs');

  const [brush, setBrush] = useState<{ startIndex: number; endIndex: number } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [fullscreenChart, setFullscreenChart] = useState<'stake' | 'rewards' | 'share' | null>(null);
  const [frozenChartData, setFrozenChartData] = useState<any[] | null>(null);
  const [showTotals, setShowTotals] = useState(true);

  function openFullscreen(type: 'stake' | 'rewards' | 'share'){
    if (!frozenChartData) setFrozenChartData(chartData);
    setFullscreenChart(type);
  }

  function closeFullscreen(){
    setFullscreenChart(null);
    setFrozenChartData(null);
  }

  useEffect(() => {
    const update = () => setIsMobile(typeof window !== 'undefined' && window.innerWidth < 640);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const microFont = isMobile ? 10 : 11;
  const segPad = isMobile ? '4px 8px' : '6px 10px';
  const chartHeight = isMobile ? 220 : 256;
  const chartPadding = isMobile ? '16px' : '24px';

  const COLORS = {
    total: '#111827',
    op0: '#60A5FA',
    op1: '#F59E0B',
    op2: '#10B981',
    op3: '#EF4444'
  } as const;

  const displayRows = useMemo(() => {
    if (range === 'All') return allCache ?? baseRows;
    const n = range === '50' ? 50 : range === '100' ? 100 : 200;
    return baseRows.slice(-n);
  }, [baseRows, range, allCache]);

  const chartRows = useMemo(() => {
    const arr = displayRows;
    if (range === 'All' && arr.length > 1200) {
      const target = 1000;
      const step = Math.ceil(arr.length / target);
      const sampled = arr.filter((_, i) => i % step === 0);
      if (sampled[sampled.length - 1] !== arr[arr.length - 1]) sampled.push(arr[arr.length - 1]);
      return sampled;
    }
    return arr;
  }, [displayRows, range]);

  const chartData = useMemo(() => {
    let prevSP0: number | null = null;
    let prevSP1: number | null = null;
    let prevSP2: number | null = null;
    let prevSP3: number | null = null;
    const base = chartRows.map((r: any) => {
      const rewardsVals = Object.values(r.rewards || {});
      let rewardsTotalNum = 0;
      try {
        const totalBig = rewardsVals.reduce((acc: bigint, v: any) => {
          try { return acc + BigInt(v); } catch { return acc; }
        }, BigInt(0));
        rewardsTotalNum = unit === 'AI3' ? tokensNumberFromShannons(totalBig.toString()) : Number(totalBig.toString());
      } catch {
        rewardsTotalNum = 0;
      }
      // Convert perquintill share prices (1e18 scale) to plain numbers for display
      const sp0Raw = r.operatorSharePrices?.['0'];
      const sp1Raw = r.operatorSharePrices?.['1'];
      const sp2Raw = r.operatorSharePrices?.['2'];
      const sp3Raw = r.operatorSharePrices?.['3'];
      let sp0 = prevSP0 ?? 1; let sp1 = prevSP1 ?? 1; let sp2 = prevSP2 ?? 1; let sp3 = prevSP3 ?? 1;
      try { if (sp0Raw) sp0 = Number(tokensPlainFromShannons(sp0Raw, 18)); } catch {}
      try { if (sp1Raw) sp1 = Number(tokensPlainFromShannons(sp1Raw, 18)); } catch {}
      try { if (sp2Raw) sp2 = Number(tokensPlainFromShannons(sp2Raw, 18)); } catch {}
      try { if (sp3Raw) sp3 = Number(tokensPlainFromShannons(sp3Raw, 18)); } catch {}
      prevSP0 = sp0; prevSP1 = sp1; prevSP2 = sp2; prevSP3 = sp3;

      return {
        epoch: r.epoch,
        totalStake: unit === 'AI3' ? tokensNumberFromShannons((function(){ try { return (BigInt(r.totalStake||'0') + BigInt(r.storageFees||'0')).toString(); } catch { return String(r.totalStake||'0'); } })()) : Number(r.totalStake ?? '0'),
        stake0: unit === 'AI3' ? tokensNumberFromShannons(r.operatorStakes?.['0'] ?? '0') : Number(r.operatorStakes?.['0'] ?? '0'),
        stake1: unit === 'AI3' ? tokensNumberFromShannons(r.operatorStakes?.['1'] ?? '0') : Number(r.operatorStakes?.['1'] ?? '0'),
        stake2: unit === 'AI3' ? tokensNumberFromShannons(r.operatorStakes?.['2'] ?? '0') : Number(r.operatorStakes?.['2'] ?? '0'),
        stake3: unit === 'AI3' ? tokensNumberFromShannons(r.operatorStakes?.['3'] ?? '0') : Number(r.operatorStakes?.['3'] ?? '0'),
        rewards0: unit === 'AI3' ? tokensNumberFromShannons(r.rewards?.['0'] ?? '0') : Number(r.rewards?.['0'] ?? '0'),
        rewards1: unit === 'AI3' ? tokensNumberFromShannons(r.rewards?.['1'] ?? '0') : Number(r.rewards?.['1'] ?? '0'),
        rewards2: unit === 'AI3' ? tokensNumberFromShannons(r.rewards?.['2'] ?? '0') : Number(r.rewards?.['2'] ?? '0'),
        rewards3: unit === 'AI3' ? tokensNumberFromShannons(r.rewards?.['3'] ?? '0') : Number(r.rewards?.['3'] ?? '0'),
        rewardsTotal: rewardsTotalNum,
        share0: sp0 || (prevSP0 ?? 1) || 1,
        share1: sp1 || (prevSP1 ?? 1) || 1,
        share2: sp2 || (prevSP2 ?? 1) || 1,
        share3: sp3 || (prevSP3 ?? 1) || 1
      };
    });
    // derive deltas (bps) and indexed series
    let first0: number | null = null;
    let first1: number | null = null;
    let first2: number | null = null;
    let first3: number | null = null;
    let prev0: number | null = null;
    let prev1: number | null = null;
    let prev2: number | null = null;
    let prev3: number | null = null;
    for (let i = 0; i < base.length; i++){
      const row: any = base[i];
      if (first0 == null && row.share0) first0 = row.share0;
      if (first1 == null && row.share1) first1 = row.share1;
      if (first2 == null && row.share2) first2 = row.share2;
      if (first3 == null && row.share3) first3 = row.share3;
      const d0 = prev0 && prev0 !== 0 ? ((row.share0 - prev0) / prev0) * 10000 : 0;
      const d1 = prev1 && prev1 !== 0 ? ((row.share1 - prev1) / prev1) * 10000 : 0;
      const d2 = prev2 && prev2 !== 0 ? ((row.share2 - prev2) / prev2) * 10000 : 0;
      const d3 = prev3 && prev3 !== 0 ? ((row.share3 - prev3) / prev3) * 10000 : 0;
      row.share0Bps = Number.isFinite(d0) ? d0 : 0;
      row.share1Bps = Number.isFinite(d1) ? d1 : 0;
      row.share2Bps = Number.isFinite(d2) ? d2 : 0;
      row.share3Bps = Number.isFinite(d3) ? d3 : 0;
      row.share0Index = first0 && first0 !== 0 ? row.share0 / first0 : 1;
      row.share1Index = first1 && first1 !== 0 ? row.share1 / first1 : 1;
      row.share2Index = first2 && first2 !== 0 ? row.share2 / first2 : 1;
      row.share3Index = first3 && first3 !== 0 ? row.share3 / first3 : 1;
      prev0 = row.share0;
      prev1 = row.share1;
      prev2 = row.share2;
      prev3 = row.share3;
    }
    return base;
  }, [chartRows, unit]);

  function computeYDomain(
    data: any[],
    keys: string[],
    mode: 'auto' | 'fit' | 'log'
  ): [number | 'auto', number | 'auto']{
    if (mode === 'auto') return ['auto', 'auto'];
    const values: number[] = [];
    for (const row of data){
      for (const k of keys){
        const v = Number((row as any)[k] ?? 0);
        if (Number.isFinite(v)) values.push(v);
      }
    }
    if (!values.length) return ['auto', 'auto'];
    if (mode === 'log'){
      const positives = values.filter(v => v > 0);
      const minPos = positives.length ? Math.min(...positives) : 1;
      return [minPos, 'auto'];
    }
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max){
      const pad = min === 0 ? 1 : Math.abs(min) * 0.02;
      return [min - pad, max + pad];
    }
    const pad = (max - min) * 0.05;
    return [min - pad, max + pad];
  }

  const stakeYDomain = useMemo(() => computeYDomain(
    chartData,
    [ ...(showTotals ? ['totalStake'] : []), ...(showOp0 ? ['stake0'] : []), ...(showOp1 ? ['stake1'] : []), ...(showOp2 ? ['stake2'] : []), ...(showOp3 ? ['stake3'] : [])],
    stakeScale
  ), [chartData, showOp0, showOp1, showOp2, showOp3, showTotals, stakeScale]);

  const rewardsYDomain = useMemo(() => {
    const keys = [ ...(showTotals ? ['rewardsTotal'] : []), ...(showOp0 ? ['rewards0'] : []), ...(showOp1 ? ['rewards1'] : []), ...(showOp2 ? ['rewards2'] : []), ...(showOp3 ? ['rewards3'] : [])];
    const hasPos = chartData.some((row:any)=> keys.some(k => Number((row as any)[k] ?? 0) > 0));
    const mode = rewardsScale === 'log' && !hasPos ? 'fit' : rewardsScale;
    return computeYDomain(chartData, keys, mode);
  }, [chartData, showOp0, showOp1, showOp2, showOp3, showTotals, rewardsScale]);

  const shareYDomain = useMemo(() => {
    const keys = shareView === 'delta'
      ? [ ...(showOp0 ? ['share0Bps'] : []), ...(showOp1 ? ['share1Bps'] : []), ...(showOp2 ? ['share2Bps'] : []), ...(showOp3 ? ['share3Bps'] : []) ]
      : shareView === 'index'
        ? [ ...(showOp0 ? ['share0Index'] : []), ...(showOp1 ? ['share1Index'] : []), ...(showOp2 ? ['share2Index'] : []), ...(showOp3 ? ['share3Index'] : []) ]
        : [ ...(showOp0 ? ['share0'] : []), ...(showOp1 ? ['share1'] : []), ...(showOp2 ? ['share2'] : []), ...(showOp3 ? ['share3'] : []) ];
    // For 'abs' view, auto-scale can look flat (values near 1.0). Force 'fit' unless user explicitly selects log.
    const mode = (shareView === 'abs' && shareScale === 'auto') ? 'fit' : (shareView === 'delta' && shareScale === 'log' ? 'fit' : shareScale);
    return computeYDomain(chartData, keys, mode);
  }, [chartData, showOp0, showOp1, showOp2, showOp3, shareScale, shareView]);

  const sharedBrushProps: any = brush ? { startIndex: brush.startIndex, endIndex: brush.endIndex } : {};
  function handleBrushChange(range: any){
    if (!range) return;
    const { startIndex, endIndex } = range as any;
    if (typeof startIndex === 'number' && typeof endIndex === 'number'){
      // Avoid redundant state updates that can cause render thrashing
      if (!brush || brush.startIndex !== startIndex || brush.endIndex !== endIndex){
        setBrush({ startIndex, endIndex });
      }
    }
  }

  // Fullscreen overlay component
  function FullscreenChart({ type, onClose }: { type: 'stake' | 'rewards' | 'share'; onClose: () => void }) {
    const fullscreenHeight = '90vh';
    const dataForChart = frozenChartData ?? chartData;

    const stakeYDomainFS = useMemo(() => computeYDomain(
      dataForChart,
      [ ...(showTotals ? ['totalStake'] : []), ...(showOp0 ? ['stake0'] : []), ...(showOp1 ? ['stake1'] : []), ...(showOp2 ? ['stake2'] : []), ...(showOp3 ? ['stake3'] : [])],
      stakeScale
    ), [dataForChart, showOp0, showOp1, showOp2, showOp3, showTotals, stakeScale]);

    const rewardsYDomainFS = useMemo(() => {
      const keys = [ ...(showTotals ? ['rewardsTotal'] : []), ...(showOp0 ? ['rewards0'] : []), ...(showOp1 ? ['rewards1'] : []), ...(showOp2 ? ['rewards2'] : []), ...(showOp3 ? ['rewards3'] : [])];
      const hasPos = (dataForChart as any[]).some((row:any)=> keys.some(k => Number((row as any)[k] ?? 0) > 0));
      const mode = rewardsScale === 'log' && !hasPos ? 'fit' : rewardsScale;
      return computeYDomain(dataForChart, keys, mode);
    }, [dataForChart, showOp0, showOp1, showOp2, showOp3, showTotals, rewardsScale]);

    const shareYDomainFS = useMemo(() => {
      const keys = shareView === 'delta'
        ? [ ...(showOp0 ? ['share0Bps'] : []), ...(showOp1 ? ['share1Bps'] : []), ...(showOp2 ? ['share2Bps'] : []), ...(showOp3 ? ['share3Bps'] : []) ]
        : shareView === 'index'
          ? [ ...(showOp0 ? ['share0Index'] : []), ...(showOp1 ? ['share1Index'] : []), ...(showOp2 ? ['share2Index'] : []), ...(showOp3 ? ['share3Index'] : []) ]
          : [ ...(showOp0 ? ['share0'] : []), ...(showOp1 ? ['share1'] : []), ...(showOp2 ? ['share2'] : []), ...(showOp3 ? ['share3'] : []) ];
      const mode = shareView === 'delta' && shareScale === 'log' ? 'fit' : shareScale;
      return computeYDomain(dataForChart, keys, mode);
    }, [dataForChart, showOp0, showOp1, showOp2, showOp3, shareScale, shareView]);
    
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}>
        <div style={{
          background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)',
          borderRadius: '16px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 25px 50px rgba(0, 0, 0, 0.25), 0 10px 20px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
          width: '95vw',
          height: '95vh',
          padding: '24px',
          position: 'relative'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '20px',
            paddingBottom: '16px',
            borderBottom: '1px solid #f3f4f6'
          }}>
            <h2 style={{
              fontSize: '24px',
              fontWeight: 600,
              color: '#111827',
              margin: 0,
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif'
            }}>
              {type === 'stake' ? 'Total Stake by Epoch' : 
               type === 'rewards' ? 'Operator Rewards per Epoch' : 
               'Operator Share Price (Perquintill)'}
            </h2>
            <button
              onClick={onClose}
              style={{
                padding: '8px 12px',
                fontSize: '14px',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                background: 'white',
                color: '#64748b',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontWeight: 500
              }}
            >
              ✕ Close
            </button>
          </div>
          
          <div style={{ height: 'calc(100% - 80px)' }}>
            <ChartErrorBoundary>
              <ResponsiveContainer width="100%" height="100%">
                {type === 'stake' ? (
                  <LineChart data={dataForChart} margin={{ top: 20, right: 40, left: 20, bottom: 40 }}>
                    <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                    <XAxis dataKey="epoch" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v)=>formatYAxisTick(Number(v), unit)} tick={{ fontSize: 12 }} domain={stakeYDomainFS} scale={stakeScale === 'log' ? 'log' : 'auto'} allowDataOverflow />
                    <Tooltip formatter={(v)=>`${formatTooltipNumber(Number(v), unit, 'stake')} ${unit}`} labelFormatter={(l)=>`Epoch ${l}`} />
                    {showTotals && <Line type="monotone" dataKey="totalStake" dot={false} name="Total Stake" strokeWidth={2} stroke={COLORS.total} />}
                    {showOp0 && <Line type="monotone" dataKey="stake0" dot={false} name="Operator 0 Stake" stroke={COLORS.op0} strokeDasharray="6 3" strokeWidth={2} />}
                    {showOp1 && <Line type="monotone" dataKey="stake1" dot={false} name="Operator 1 Stake" stroke={COLORS.op1} strokeDasharray="6 3" strokeWidth={2} />}
                    {showOp2 && <Line type="monotone" dataKey="stake2" dot={false} name="Operator 2 Stake" stroke={COLORS.op2} strokeDasharray="6 3" strokeWidth={2} />}
                    {showOp3 && <Line type="monotone" dataKey="stake3" dot={false} name="Operator 3 Stake" stroke={COLORS.op3} strokeDasharray="6 3" strokeWidth={2} />}
                  </LineChart>
                ) : type === 'rewards' ? (
                  <ComposedChart data={dataForChart} margin={{ top: 20, right: 40, left: 20, bottom: 40 }}>
                    <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                    <XAxis dataKey="epoch" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v)=>formatYAxisTick(Number(v), unit)} tick={{ fontSize: 12 }} domain={rewardsYDomainFS} scale={rewardsScale === 'log' ? 'log' : 'auto'} allowDataOverflow />
                    <Tooltip formatter={(v)=>`${formatTooltipNumber(Number(v), unit, 'rewards')} ${unit}`} labelFormatter={(l)=>`Epoch ${l}`} />
                    {showOp0 && <Bar dataKey="rewards0" name="Operator 0" fill={COLORS.op0} radius={[3,3,0,0]} />}
                    {showOp1 && <Bar dataKey="rewards1" name="Operator 1" fill={COLORS.op1} radius={[3,3,0,0]} />}
                    {showOp2 && <Bar dataKey="rewards2" name="Operator 2" fill={COLORS.op2} radius={[3,3,0,0]} />}
                    {showOp3 && <Bar dataKey="rewards3" name="Operator 3" fill={COLORS.op3} radius={[3,3,0,0]} />}
                    {showTotals && <Line type="monotone" dataKey="rewardsTotal" name="Total Rewards" dot={false} stroke={COLORS.total} strokeWidth={3} connectNulls />}
                  </ComposedChart>
                ) : (
                  <LineChart data={dataForChart} margin={{ top: 20, right: 40, left: 20, bottom: 40 }}>
                    <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                    <XAxis dataKey="epoch" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v)=> {
                      if (shareView === 'delta') return `${Number(v).toFixed(1)} bps`;
                      if (shareView === 'index') return Number(v).toExponential(2);
                      return Number(v).toExponential(2);
                    }} tick={{ fontSize: 12 }} domain={shareYDomainFS} scale={shareScale === 'log' ? 'log' : 'auto'} allowDataOverflow />
                    <Tooltip formatter={(v)=> {
                      if (shareView === 'delta') return `${Number(v).toFixed(2)} bps`;
                      if (shareView === 'index') return `${Number(v).toExponential(6)}×`;
                      return Number(v).toExponential(8);
                    }} labelFormatter={(l)=>`Epoch ${l}`} />
                    {showOp0 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share0Bps' : (shareView === 'index' ? 'share0Index' : 'share0')} dot={false} name="Operator 0" stroke={COLORS.op0} strokeWidth={2} />}
                    {showOp1 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share1Bps' : (shareView === 'index' ? 'share1Index' : 'share1')} dot={false} name="Operator 1" stroke={COLORS.op1} strokeWidth={2} />}
                    {showOp2 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share2Bps' : (shareView === 'index' ? 'share2Index' : 'share2')} dot={false} name="Operator 2" stroke={COLORS.op2} strokeWidth={2} />}
                    {showOp3 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share3Bps' : (shareView === 'index' ? 'share3Index' : 'share3')} dot={false} name="Operator 3" stroke={COLORS.op3} strokeWidth={2} />}
                  </LineChart>
                )}
              </ResponsiveContainer>
            </ChartErrorBoundary>
          </div>
        </div>
      </div>
    );
  }

  const handleDownloadCSV = () => {
    const opsStakeKeys = Array.from(new Set(displayRows.flatMap((r: any) => Object.keys(r.operatorStakes || {})))).sort((a,b)=>Number(a)-Number(b));
    const opsRewardKeys = Array.from(new Set(displayRows.flatMap((r: any) => Object.keys(r.rewards || {})))).sort((a,b)=>Number(a)-Number(b));
    const header = ['epoch','startBlock','endBlock','totalStake', ...opsStakeKeys.map(k=>`stake${k}`), ...opsRewardKeys.map(k=>`rewards${k}`)];
    const csvRows = displayRows.map((r: any) => {
      // Use raw values without any formatting - keep as bigints/shannons
      const totalStakeStr = String(r.totalStake ?? '0');
      const stakeVals = opsStakeKeys.map((k)=> String(r.operatorStakes?.[k] ?? '0'));
      const rewardVals = opsRewardKeys.map((k)=> String(r.rewards?.[k] ?? '0'));
      return [r.epoch, r.startBlock, r.endBlock, totalStakeStr, ...stakeVals, ...rewardVals];
    });
    const csv = [header.join(','), ...csvRows.map((r:any)=>r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const latestEpoch = baseRows.length ? baseRows[baseRows.length - 1].epoch : '';
    a.download = `epochs_raw${latestEpoch !== '' ? `_e${latestEpoch}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ minHeight: '100vh', padding: isMobile ? '12px' : '16px 3%', background: 'linear-gradient(135deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%)' }}>
      <DashboardHeader 
        isLive={isLive}
        liveStatus={liveStatus}
        lastLiveAt={lastLiveAt}
        setIsLive={setIsLive}
        setLiveStatus={setLiveStatus}
        onDownloadCSV={handleDownloadCSV}
        isMobile={isMobile}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 0, marginBottom: isMobile ? 16 : 20 }}>
        <div>
          <DomainSummary summary={summary as any} isMobile={isMobile} />
        </div>
        {Array.isArray((summary as any).latestSharePrices) && (summary as any).latestSharePrices.length > 0 && (
          <div>
            <OperatorTable rows={displayRows} latest={summary as any} isMobile={isMobile} />
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: isMobile ? '12px' : '16px' }}>
        <div style={{ 
          display: 'flex', 
          flexWrap: 'wrap', 
          gap: isMobile ? '8px' : '10px', 
          alignItems: 'center', 
          background: 'linear-gradient(135deg, #e2e8f0 0%, #d1d5db 100%)', 
          border: '2px solid #9ca3af', 
          borderRadius: '10px', 
          padding: isMobile ? '12px 16px' : '16px 20px', 
          boxShadow: '0 6px 12px rgba(0,0,0,0.15), 0 2px 6px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255, 255, 255, 0.3)', 
          position: 'sticky', 
          top: 0, 
          zIndex: 20, 
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
          backdropFilter: 'blur(12px)'
        }}>
          <div style={{ fontSize: isMobile ? 12 : 13, color: '#374151', fontWeight: 600 }}>Chart Controls:</div>
          
          <div style={{ fontSize: microFont, color: '#6b7280' }}>Range:</div>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
            {(['50','100','200','All'] as const).map(key => (
              <button
                key={key}
                onClick={() => setRange(key)}
                style={{
                  padding: segPad,
                  fontSize: microFont,
                  background: range === key ? '#111827' : 'white',
                  color: range === key ? 'white' : '#111827',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease-in-out',
                  fontWeight: range === key ? 600 : 500
                }}
                onMouseEnter={(e) => {
                  if (range !== key) {
                    e.currentTarget.style.background = '#f3f4f6';
                  }
                }}
                onMouseLeave={(e) => {
                  if (range !== key) {
                    e.currentTarget.style.background = 'white';
                  }
                }}
              >{key === 'All' ? 'All' : `Last ${key}`}</button>
            ))}
          </div>
          
          <div style={{ width: '1px', height: '16px', background: '#d1d5db', margin: '0 4px' }} />
          
          <div style={{ fontSize: microFont, color: '#6b7280' }}>Unit:</div>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
            {(['AI3','Shannons'] as const).map(key => (
              <button
                key={key}
                onClick={() => setUnit(key)}
                style={{
                  padding: segPad,
                  fontSize: microFont,
                  background: unit === key ? '#111827' : 'white',
                  color: unit === key ? 'white' : '#111827',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease-in-out',
                  fontWeight: unit === key ? 600 : 500
                }}
                onMouseEnter={(e) => {
                  if (unit !== key) {
                    e.currentTarget.style.background = '#f3f4f6';
                  }
                }}
                onMouseLeave={(e) => {
                  if (unit !== key) {
                    e.currentTarget.style.background = 'white';
                  }
                }}
              >{key}</button>
            ))}
          </div>
          <div style={{ width: '1px', height: '16px', background: '#d1d5db', margin: '0 4px' }} />
          <div style={{ fontSize: microFont, color: '#6b7280' }}>Totals:</div>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
            {[true, false].map(val => (
              <button
                key={String(val)}
                onClick={() => setShowTotals(val)}
                style={{
                  padding: segPad,
                  fontSize: microFont,
                  background: showTotals === val ? '#111827' : 'white',
                  color: showTotals === val ? 'white' : '#111827',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease-in-out',
                  fontWeight: showTotals === val ? 600 : 500
                }}
              >{val ? 'On' : 'Off'}</button>
            ))}
          </div>

          <div style={{ width: '1px', height: '16px', background: '#d1d5db', margin: '0 4px' }} />
          <div style={{ fontSize: microFont, color: '#6b7280' }}>Operators:</div>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            {[{id:'0',color:COLORS.op0,state:showOp0,set:setShowOp0,label:'Op 0'}, {id:'1',color:COLORS.op1,state:showOp1,set:setShowOp1,label:'Op 1'}, {id:'2',color:COLORS.op2,state:showOp2,set:setShowOp2,label:'Op 2'}, {id:'3',color:COLORS.op3,state:showOp3,set:setShowOp3,label:'Op 3'}].map(op => (
              <label key={op.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, background: op.state ? '#f8fafc' : 'white', border: `1px solid ${op.state ? op.color : '#e2e8f0'}`, color: op.state ? op.color : '#64748b', cursor: 'pointer' }}>
                <input type="checkbox" checked={op.state} onChange={(e)=>op.set(e.target.checked)} style={{ display: 'none' }} />
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: op.color }} />
                <span style={{ fontSize: microFont }}>{op.label}</span>
              </label>
            ))}
          </div>

          
        </div>
        <div style={{ 
          background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)', 
          borderRadius: '12px', 
          border: '2px solid #9ca3af', 
          boxShadow: '0 8px 16px rgba(0,0,0,0.18), 0 4px 8px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255, 255, 255, 0.3)', 
          padding: isMobile ? '16px' : '20px',
          position: 'relative'
        }}>
          <h2 style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            fontSize: '18px', 
            fontWeight: 600, 
            color: '#111827', 
            paddingBottom: '12px', 
            marginBottom: '16px', 
            borderBottom: '1px solid #f3f4f6', 
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>Total Stake by Epoch</span>
              {isLive && <span title="Live" style={{ width: 6, height: 6, borderRadius: '50%', background: '#10B981', display: 'inline-block' }} />}
            </div>
            <button
              onClick={() => (fullscreenChart === 'stake' ? closeFullscreen() : openFullscreen('stake'))}
              style={{
                padding: isMobile ? '8px 12px' : '10px 16px',
                fontSize: isMobile ? '14px' : '16px',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                background: fullscreenChart === 'stake' ? '#111827' : 'white',
                color: fullscreenChart === 'stake' ? 'white' : '#374151',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontWeight: 600,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
              title="Toggle fullscreen"
              onMouseEnter={(e) => {
                if (fullscreenChart !== 'stake') {
                  e.currentTarget.style.background = '#f3f4f6';
                }
              }}
              onMouseLeave={(e) => {
                if (fullscreenChart !== 'stake') {
                  e.currentTarget.style.background = 'white';
                }
              }}
            >
              {fullscreenChart === 'stake' ? '⤓' : '⤢'} {isMobile ? '' : 'Fullscreen'}
            </button>
          </h2>
          <div style={{ height: fullscreenChart === 'stake' ? '80vh' : chartHeight }}>
            <ChartErrorBoundary>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 24, left: 8, bottom: 24 }} syncId="epochs" syncMethod="index">
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                <XAxis dataKey="epoch" tick={{ fontSize: microFont }} />
                <YAxis tickFormatter={(v)=>formatYAxisTick(Number(v), unit)} tick={{ fontSize: microFont }} domain={stakeYDomain} scale={stakeScale === 'log' ? 'log' : 'auto'} allowDataOverflow />
                <Tooltip formatter={(v)=>`${formatTooltipNumber(Number(v), unit, 'stake')} ${unit}`} labelFormatter={(l)=>`Epoch ${l}`} />
                {showTotals && <Line type="monotone" dataKey="totalStake" dot={false} name="Total Stake" strokeWidth={2} stroke={COLORS.total} />}
                {showOp0 && <Line type="monotone" dataKey="stake0" dot={false} name="Operator 0 Stake" stroke={COLORS.op0} strokeDasharray="4 2" />}
                {showOp1 && <Line type="monotone" dataKey="stake1" dot={false} name="Operator 1 Stake" stroke={COLORS.op1} strokeDasharray="4 2" />}
                {showOp2 && <Line type="monotone" dataKey="stake2" dot={false} name="Operator 2 Stake" stroke={COLORS.op2} strokeDasharray="4 2" />}
                {showOp3 && <Line type="monotone" dataKey="stake3" dot={false} name="Operator 3 Stake" stroke={COLORS.op3} strokeDasharray="4 2" />}
                <Brush dataKey="epoch" height={isMobile ? 12 : 14} stroke="#9CA3AF" travellerWidth={isMobile ? 6 : 8} onChange={handleBrushChange} {...sharedBrushProps} />
              </LineChart>
            </ResponsiveContainer>
            </ChartErrorBoundary>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginTop: 8, flexWrap: 'wrap', gap: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
            <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '4px', overflow: 'hidden', flexShrink: 0 }}>
              {(['auto','fit','log'] as const).map(key => (
                <button
                  key={key}
                  onClick={() => setStakeScale(key)}
                  style={{
                    padding: isMobile ? '3px 6px' : '4px 8px',
                    fontSize: microFont,
                    textTransform: 'capitalize',
                    background: stakeScale === key ? '#0f172a' : 'white',
                    color: stakeScale === key ? 'white' : '#64748b',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: stakeScale === key ? 500 : 400
                  }}
                >{key}</button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ 
          background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)', 
          borderRadius: '12px', 
          border: '2px solid #9ca3af', 
          boxShadow: '0 8px 16px rgba(0,0,0,0.18), 0 4px 8px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255, 255, 255, 0.3)', 
          padding: isMobile ? '16px' : '20px',
          position: 'relative'
        }}>
          <h2 style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            fontSize: '18px', 
            fontWeight: 600, 
            color: '#111827', 
            paddingBottom: '12px', 
            marginBottom: '16px', 
            borderBottom: '1px solid #f3f4f6', 
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>Operator Rewards per Epoch</span>
              {isLive && <span title="Live" style={{ width: 6, height: 6, borderRadius: '50%', background: '#10B981', display: 'inline-block' }} />}
            </div>
            <button
              onClick={() => (fullscreenChart === 'rewards' ? closeFullscreen() : openFullscreen('rewards'))}
              style={{
                padding: isMobile ? '8px 12px' : '10px 16px',
                fontSize: isMobile ? '14px' : '16px',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                background: fullscreenChart === 'rewards' ? '#111827' : 'white',
                color: fullscreenChart === 'rewards' ? 'white' : '#374151',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontWeight: 600,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
              title="Toggle fullscreen"
              onMouseEnter={(e) => {
                if (fullscreenChart !== 'rewards') {
                  e.currentTarget.style.background = '#f3f4f6';
                }
              }}
              onMouseLeave={(e) => {
                if (fullscreenChart !== 'rewards') {
                  e.currentTarget.style.background = 'white';
                }
              }}
            >
              {fullscreenChart === 'rewards' ? '⤓' : '⤢'} {isMobile ? '' : 'Fullscreen'}
            </button>
          </h2>
          <div style={{ height: fullscreenChart === 'rewards' ? '80vh' : chartHeight }}>
            <ChartErrorBoundary>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 24, left: 8, bottom: 24 }} syncId="epochs" syncMethod="index">
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                <XAxis dataKey="epoch" tick={{ fontSize: microFont }} />
                <YAxis tickFormatter={(v)=>formatYAxisTick(Number(v), unit)} tick={{ fontSize: microFont }} domain={rewardsYDomain} scale={rewardsScale === 'log' && chartData.some((row:any)=> ['rewardsTotal','rewards0','rewards1','rewards2','rewards3'].some(k => Number((row as any)[k] ?? 0) > 0)) ? 'log' : 'auto'} allowDataOverflow />
                <Tooltip formatter={(v)=>`${formatTooltipNumber(Number(v), unit, 'rewards')} ${unit}`} labelFormatter={(l)=>`Epoch ${l}`} />
                {showOp0 && <Bar dataKey="rewards0" name="Operator 0" fill={COLORS.op0} radius={[2,2,0,0]} />}
                {showOp1 && <Bar dataKey="rewards1" name="Operator 1" fill={COLORS.op1} radius={[2,2,0,0]} />}
                {showOp2 && <Bar dataKey="rewards2" name="Operator 2" fill={COLORS.op2} radius={[2,2,0,0]} />}
                {showOp3 && <Bar dataKey="rewards3" name="Operator 3" fill={COLORS.op3} radius={[2,2,0,0]} />}
                {showTotals && <Line type="monotone" dataKey="rewardsTotal" name="Total Rewards" dot={false} stroke={COLORS.total} strokeWidth={2} connectNulls />}
                <Brush dataKey="epoch" height={isMobile ? 12 : 14} stroke="#9CA3AF" travellerWidth={isMobile ? 6 : 8} onChange={handleBrushChange} {...sharedBrushProps} />
              </ComposedChart>
            </ResponsiveContainer>
            </ChartErrorBoundary>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginTop: 8, flexWrap: 'wrap', gap: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
            <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '4px', overflow: 'hidden', flexShrink: 0 }}>
              {(['auto','fit','log'] as const).map(key => (
                <button
                  key={key}
                  onClick={() => setRewardsScale(key)}
                  style={{
                    padding: isMobile ? '3px 6px' : '4px 8px',
                    fontSize: microFont,
                    textTransform: 'capitalize',
                    background: rewardsScale === key ? '#0f172a' : 'white',
                    color: rewardsScale === key ? 'white' : '#64748b',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: rewardsScale === key ? 500 : 400
                  }}
                >{key}</button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ 
          background: 'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)', 
          borderRadius: '12px', 
          border: '2px solid #9ca3af', 
          boxShadow: '0 8px 16px rgba(0,0,0,0.18), 0 4px 8px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255, 255, 255, 0.3)', 
          padding: isMobile ? '16px' : '20px',
          position: 'relative'
        }}>
          <h2 style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            fontSize: '18px', 
            fontWeight: 600, 
            color: '#111827', 
            paddingBottom: '12px', 
            marginBottom: '16px', 
            borderBottom: '1px solid #f3f4f6', 
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>Operator Share Price (Perquintill)</span>
            </div>
            <button
              onClick={() => (fullscreenChart === 'share' ? closeFullscreen() : openFullscreen('share'))}
              style={{
                padding: isMobile ? '8px 12px' : '10px 16px',
                fontSize: isMobile ? '14px' : '16px',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                background: fullscreenChart === 'share' ? '#111827' : 'white',
                color: fullscreenChart === 'share' ? 'white' : '#374151',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontWeight: 600,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
              title="Toggle fullscreen"
              onMouseEnter={(e) => {
                if (fullscreenChart !== 'share') {
                  e.currentTarget.style.background = '#f3f4f6';
                }
              }}
              onMouseLeave={(e) => {
                if (fullscreenChart !== 'share') {
                  e.currentTarget.style.background = 'white';
                }
              }}
            >
              {fullscreenChart === 'share' ? '⤓' : '⤢'} {isMobile ? '' : 'Fullscreen'}
            </button>
          </h2>
          <div style={{ height: fullscreenChart === 'share' ? '80vh' : chartHeight }}>
            <ChartErrorBoundary>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 24, left: 8, bottom: 24 }} syncId="epochs" syncMethod="index">
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                <XAxis dataKey="epoch" tick={{ fontSize: microFont }} />
                <YAxis tickFormatter={(v)=> {
                  if (shareView === 'delta') return `${Number(v).toFixed(1)} bps`;
                  if (shareView === 'index') return Number(v).toFixed(6);
                  return Number(v).toFixed(6);
                }} tick={{ fontSize: microFont }} domain={shareYDomain} scale={shareScale === 'log' ? 'log' : 'auto'} allowDataOverflow />
                <Tooltip formatter={(v)=> {
                  if (shareView === 'delta') return `${Number(v).toFixed(2)} bps`;
                  if (shareView === 'index') return `${Number(v).toFixed(8)}×`;
                  return Number(v).toFixed(8);
                }} labelFormatter={(l)=>`Epoch ${l}`} />
                {showOp0 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share0Bps' : (shareView === 'index' ? 'share0Index' : 'share0')} dot={false} name="Operator 0" stroke={COLORS.op0} />}
                {showOp1 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share1Bps' : (shareView === 'index' ? 'share1Index' : 'share1')} dot={false} name="Operator 1" stroke={COLORS.op1} />}
                {showOp2 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share2Bps' : (shareView === 'index' ? 'share2Index' : 'share2')} dot={false} name="Operator 2" stroke={COLORS.op2} />}
                {showOp3 && <Line type="monotone" dataKey={shareView === 'delta' ? 'share3Bps' : (shareView === 'index' ? 'share3Index' : 'share3')} dot={false} name="Operator 3" stroke={COLORS.op3} />}
                <Brush dataKey="epoch" height={isMobile ? 12 : 14} stroke="#9CA3AF" travellerWidth={isMobile ? 6 : 8} onChange={handleBrushChange} {...sharedBrushProps} />
              </LineChart>
            </ResponsiveContainer>
            </ChartErrorBoundary>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginTop: 8, flexWrap: 'wrap', gap: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
            <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '4px', overflow: 'hidden', flexShrink: 0 }}>
              {(['auto','fit','log'] as const).map(key => (
                <button
                  key={key}
                  onClick={() => setShareScale(key)}
                  style={{
                    padding: isMobile ? '3px 6px' : '4px 8px',
                    fontSize: microFont,
                    textTransform: 'capitalize',
                    background: shareScale === key ? '#0f172a' : 'white',
                    color: shareScale === key ? 'white' : '#64748b',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: shareScale === key ? 500 : 400
                  }}
                >{key}</button>
              ))}
            </div>
            <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: '4px', overflow: 'hidden', flexShrink: 0 }}>
              {(['delta','index','abs'] as const).map(key => (
                <button
                  key={key}
                  onClick={() => setShareView(key)}
                  style={{
                    padding: isMobile ? '3px 6px' : '4px 8px',
                    fontSize: microFont,
                    textTransform: 'capitalize',
                    background: shareView === key ? '#0f172a' : 'white',
                    color: shareView === key ? 'white' : '#64748b',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: shareView === key ? 500 : 400
                  }}
                >{key}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Fullscreen Chart Overlay */}
      {fullscreenChart && (
        <FullscreenChart 
          type={fullscreenChart} 
          onClose={closeFullscreen} 
        />
      )}
    </div>
  );
}
