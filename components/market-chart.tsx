'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartPoint } from '@/lib/types';

const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export function MarketChart({ data, positive, compact = false }: { data: ChartPoint[]; positive: boolean; compact?: boolean }) {
  const reduced = compact ? data.filter((_, index) => index % Math.max(1, Math.floor(data.length / 60)) === 0) : data;
  const color = positive ? '#bbf451' : '#ff6969';
  if (!data.length) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No price history</div>;
  return <ResponsiveContainer width="100%" height="100%">
    <AreaChart data={reduced} margin={compact ? { top: 3, right: 0, bottom: 0, left: 0 } : { top: 10, right: 8, bottom: 0, left: 0 }}>
      <defs><linearGradient id={`fill-${positive}-${compact}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.24}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
      {!compact && <CartesianGrid stroke="#202728" strokeDasharray="3 3" vertical={false}/>} 
      {!compact && <XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { weekday: 'short' })} axisLine={false} tickLine={false} tick={{ fill: '#84908b', fontSize: 10 }} minTickGap={50}/>} 
      {!compact && <YAxis domain={['auto', 'auto']} hide/>}
      {!compact && <Tooltip contentStyle={{ background: '#111617', border: '1px solid #293132', borderRadius: 8, fontSize: 12 }} labelFormatter={(value) => new Date(Number(String(value))).toLocaleString()} formatter={(value) => [price.format(Number(String(value))), 'Price']}/>} 
      <Area type="monotone" dataKey="price" stroke={color} strokeWidth={compact ? 1.6 : 2} fill={`url(#fill-${positive}-${compact})`} isAnimationActive={false}/>
    </AreaChart>
  </ResponsiveContainer>;
}
