import fs from 'node:fs';
import readline from 'node:readline';
const root=process.cwd();
const store=JSON.parse(fs.readFileSync(`${root}/data/cycle-paths.json`,'utf8'));
const now=Date.now();
function settlementReturn(c){
 const pts=(c.points??[]).filter(p=>p.offsetSeconds>=820&&p.offsetSeconds<=910&&Number.isFinite(p.price));
 if(pts.length<2)return NaN;
 // Trapezoidal time-weighted mean over observed final-minute vicinity, clipped to [840,900].
 const sorted=[...pts].sort((a,b)=>a.offsetSeconds-b.offsetSeconds);let area=0,duration=0;
 for(let i=1;i<sorted.length;i++){const a=Math.max(840,sorted[i-1].offsetSeconds),b=Math.min(900,sorted[i].offsetSeconds);if(b<=a)continue;area+=(sorted[i-1].price+sorted[i].price)/2*(b-a);duration+=b-a;}
 const avg=duration>=30?area/duration:sorted.reduce((s,p)=>s+p.price,0)/sorted.length;
 return avg/c.referencePrice-1;
}
const rows=store.cycles.map(c=>({symbol:c.symbol,close:c.closesAt,closeMs:Date.parse(c.closesAt),coverage:c.features?.coverageSeconds??0,n:c.features?.observationCount??0,eff:c.features?.trendEfficiency??null,flips:c.features?.signFlipRate??null,regime:c.features?.regime,ret:settlementReturn(c)})).filter(r=>r.closeMs<=now&&r.coverage>=800&&r.n>=20&&Number.isFinite(r.ret)&&Math.abs(r.ret)>1e-10);
const bySymbol=new Map();for(const r of rows){const a=bySymbol.get(r.symbol)??[];a.push(r);bySymbol.set(r.symbol,a)}for(const a of bySymbol.values())a.sort((x,y)=>x.closeMs-y.closeMs);
const targets=[];
for(const a of bySymbol.values())for(let i=1;i<a.length;i++){
 const current=a[i];if(current.closeMs-a[i-1].closeMs!==900000)continue;
 const priorDirection=a[i-1].ret<0?'DOWN':'UP';let streak=0,cum=0,effs=[],flips=[];
 for(let j=i-1;j>=0;j--){if((j<i-1&&a[j+1].closeMs-a[j].closeMs!==900000)||(a[j].ret<0?'DOWN':'UP')!==priorDirection)break;streak++;cum+=a[j].ret;if(a[j].eff!==null)effs.push(a[j].eff);if(a[j].flips!==null)flips.push(a[j].flips)}
 targets.push({...current,targetDirection:current.ret<0?'DOWN':'UP',priorDirection,streak,priorCumReturn:cum,priorMeanEfficiency:effs.length?effs.reduce((s,x)=>s+x,0)/effs.length:null,priorMeanFlipRate:flips.length?flips.reduce((s,x)=>s+x,0)/flips.length:null});
}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;const pct=x=>`${(x*100).toFixed(2)}%`;const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor((s.length-1)*p)]};
function clusterSummary(items,predicate){const groups=new Map();for(const x of items){const a=groups.get(x.close)??[];a.push(predicate(x)?1:0);groups.set(x.close,a)}const vals=[...groups.values()].map(mean),m=mean(vals);const variance=vals.length>1?vals.reduce((s,x)=>s+(x-m)**2,0)/(vals.length-1):NaN,se=Math.sqrt(variance/vals.length);return {rows:items.length,windows:vals.length,rate:m,se,lo:m-1.96*se,hi:m+1.96*se};}
function line(label,items,pred=x=>x.targetDirection==='DOWN'){const s=clusterSummary(items,pred);console.log(label,{rows:s.rows,windows:s.windows,rate:pct(s.rate),ci95:`${pct(s.lo)}..${pct(s.hi)}`,meanNextReturn:pct(mean(items.map(x=>x.ret)))})}
console.log('\nDATA',{cycles:rows.length,targets:targets.length,assets:[...bySymbol.keys()],range:[new Date(Math.min(...rows.map(r=>r.closeMs))).toISOString(),new Date(Math.max(...rows.map(r=>r.closeMs))).toISOString()]});
line('Base next DOWN',targets);
for(const k of [1,2,3,4])line(`Prior DOWN streak >=${k}`,targets.filter(x=>x.priorDirection==='DOWN'&&x.streak>=k));
for(const k of [1,2,3,4])line(`Continuation after either-side streak >=${k}`,targets.filter(x=>x.streak>=k),x=>x.targetDirection===x.priorDirection);
const multiDown=targets.filter(x=>x.priorDirection==='DOWN'&&x.streak>=2);const medianDecline=q(multiDown.map(x=>Math.abs(x.priorCumReturn)),.5);const medianEff=q(multiDown.map(x=>x.priorMeanEfficiency??0),.5);
line(`Multi-DOWN larger cumulative decline >=${pct(medianDecline)}`,multiDown.filter(x=>Math.abs(x.priorCumReturn)>=medianDecline));
line(`Multi-DOWN smaller cumulative decline <${pct(medianDecline)}`,multiDown.filter(x=>Math.abs(x.priorCumReturn)<medianDecline));
line(`Multi-DOWN smoother >=median efficiency ${medianEff.toFixed(3)}`,multiDown.filter(x=>(x.priorMeanEfficiency??0)>=medianEff));
line(`Multi-DOWN choppier <median efficiency ${medianEff.toFixed(3)}`,multiDown.filter(x=>(x.priorMeanEfficiency??0)<medianEff));
console.log('\nASSET multi-DOWN >=2');for(const symbol of [...bySymbol.keys()].sort())line(symbol,multiDown.filter(x=>x.symbol===symbol));
const midpoint=q(multiDown.map(x=>x.closeMs),.5);console.log('\nCHRONOLOGICAL');line('First half multi-DOWN',multiDown.filter(x=>x.closeMs<=midpoint));line('Second half multi-DOWN',multiDown.filter(x=>x.closeMs>midpoint));

// Fixed five-minute issuance replay: same-contract Kalshi DOWN ask and Kalshi outcome only.
const targetByKey=new Map(multiDown.map(x=>[`${x.symbol}:${x.close}`,x]));const selected=new Map();const selectedById=new Map();
function consider(f){const key=`${f.symbol}:${f.closesAt}`,target=targetByKey.get(key);if(!target)return;const desired=target.closeMs-600000;const distance=Math.abs(Date.parse(f.issuedAt)-desired);if(distance>90000)return;const old=selected.get(key);if(!old||distance<old.distance){if(old)selectedById.delete(old.forecast.id);const item={distance,forecast:f,target};selected.set(key,item);selectedById.set(f.id,item)}}
async function streamSnapshot(){const rl=readline.createInterface({input:fs.createReadStream(`${root}/data/forecast-history.json`),crlfDelay:Infinity});let acc=null;for await(const line of rl){if(line==='  {')acc=['{'];else if(acc){if(line==='  },'||line==='  }'){acc.push('}');try{consider(JSON.parse(acc.join('\n')))}catch{}acc=null}else acc.push(line.slice(2));}}}
await streamSnapshot();
if(fs.existsSync(`${root}/data/forecast-history.journal.jsonl`))for(const line of fs.readFileSync(`${root}/data/forecast-history.journal.jsonl`,'utf8').split('\n')){if(!line)continue;let e;try{e=JSON.parse(line)}catch{continue}if(e.op==='upsert')consider(e.forecast);else if(e.op==='patch'){const item=selectedById.get(e.id);if(item)item.forecast={...item.forecast,...e.changes}}else if(e.op==='delete'){const item=selectedById.get(e.id);if(item){selected.delete(`${item.forecast.symbol}:${item.forecast.closesAt}`);selectedById.delete(e.id)}}}
const tradeRows=[];for(const {forecast:f,target} of selected.values()){
 const ask=f.actionableVenuePrices?.find(x=>x.venue==='kalshi'&&x.side==='DOWN')?.price;const ref=f.venueContracts?.kalshi,out=f.venueOutcomes?.kalshi;if(!(ask>0&&ask<1)||!ref||!out||ref.contractId!==out.contractId||!['UP','DOWN'].includes(out.outcome))continue;const fee=.07*ask*(1-ask),cost=ask+fee,win=out.outcome==='DOWN',roi=((win?1:0)-cost)/cost;const modelDown=1-f.probabilityUp,edge=modelDown-cost;tradeRows.push({...target,ask,cost,win,roi,edge,quality:f.confidence,qualified:edge>=.05&&f.confidence>=.5});}
function tradeLine(label,a){const win=clusterSummary(a,x=>x.win),returns=a.map(x=>x.roi),windows=new Set(a.map(x=>x.close)).size;console.log(label,{trades:a.length,windows,winRate:pct(win.rate),meanROI:pct(mean(returns)),medianROI:pct(q(returns,.5)),meanAsk:pct(mean(a.map(x=>x.ask))),meanEdge:pct(mean(a.map(x=>x.edge)))})}
console.log('\nKALSHI 5-MINUTE FIXED-SNAPSHOT DOWN BUY AFTER PRIOR DOWN >=2');tradeLine('All available same-contract rows',tradeRows);tradeLine('Rows also clearing production edge/quality',tradeRows.filter(x=>x.qualified));
console.log('Coverage',{multiDownTargets:multiDown.length,fiveMinuteForecasts:selected.size,sameContractResolvedQuotes:tradeRows.length});
