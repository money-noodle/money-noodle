'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PerformanceTimelinePoint } from '@/lib/types';

export function PerformanceChart({ data }: { data: PerformanceTimelinePoint[] }) {
  if (data.length < 2) return <div className="grid h-44 place-items-center rounded-lg border text-center"><div><p className="text-xs">Accuracy over time will appear here</p><p className="mt-1 text-[10px] text-muted-foreground">At least two resolved positive-edge buys are needed.</p></div></div>;
  return <div className="h-52 rounded-lg border bg-background/30 p-2">
    <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -18 }}>
      <CartesianGrid stroke="#202728" strokeDasharray="3 3" vertical={false}/>
      <XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} axisLine={false} tickLine={false} minTickGap={45} tick={{ fill: '#84908b', fontSize: 9 }}/>
      <YAxis domain={[0, 1]} tickFormatter={(value) => `${Math.round(value * 100)}%`} axisLine={false} tickLine={false} tick={{ fill: '#84908b', fontSize: 9 }}/>
      <Tooltip contentStyle={{ background: '#111617', border: '1px solid #293132', borderRadius: 8, fontSize: 11 }} labelFormatter={(value) => new Date(String(value)).toLocaleString()} formatter={(value, name) => [`${(Number(value) * 100).toFixed(1)}%`, name === 'rollingAccuracy' ? 'Rolling last 25' : 'Cumulative']}/>
      <Line type="monotone" dataKey="cumulativeAccuracy" stroke="#edf2ef" strokeWidth={1.5} dot={false} isAnimationActive={false}/>
      <Line type="monotone" dataKey="rollingAccuracy" stroke="#bbf451" strokeWidth={2} dot={false} isAnimationActive={false}/>
    </LineChart></ResponsiveContainer>
  </div>;
}
