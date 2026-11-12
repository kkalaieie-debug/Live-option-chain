import { config } from './config.js';
import { saveTick, saveOiSnapshot } from './db.js';
import { classifyOi, calculateGreeks, summarizeOptions } from './analytics.js';
import { connectAngel, subscribeAngel, getAngelLtp } from './angel.js';
import { buildContracts } from './instruments.js';
const latest = new Map(), clients = new Set(), lastPersist = new Map();
let contracts = { indices:{} }, socket = null;
const keyOf = c => `${c.indexName}:${c.segment}:${c.token}`;
function emit(p) { const s=JSON.stringify(p); for (const c of clients) if(c.readyState===1)c.send(s); }
export function addClient(ws) { clients.add(ws); ws.send(JSON.stringify({type:'snapshot',data:getDashboard()})); ws.on('close',()=>clients.delete(ws)); }
function normalize(raw) {
  if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) { console.warn('[feed] SDK emitted undecoded binary tick'); return null; }
  const token=String(raw?.token??raw?.symbolToken??raw?.symboltoken??'');
  const v=Number(raw?.last_traded_price??raw?.ltp??raw?.lastTradedPrice);
  if(!token || !Number.isFinite(v)) return null;
  return {token,ltp:v>100000?v/100:v,oi:Number(raw.open_interest??raw.openInterest??raw.oi??0),volume:Number(raw.volume_trade_for_the_day??raw.volume??0),exchangeTime:raw.exchange_timestamp??raw.exchangeTime??null};
}
function find(token) {
  for(const [indexName,idx] of Object.entries(contracts.indices)) {
    for(const [field,segment] of [['options','option'],['futures','future']]) { const c=(idx[field]||[]).find(x=>String(x.token)===token); if(c)return {...c,indexName,segment}; }
    if(String(idx.spot?.token||'')===token)return {...idx.spot,indexName,segment:'spot'};
  } return null;
}
async function onTick(raw) {
  const n=normalize(raw); if(!n)return; const c=find(n.token); if(!c)return;
  const key=keyOf({...c,token:n.token}),old=latest.get(key),priceChange=old?n.ltp-old.ltp:0,oiChange=old?n.oi-old.oi:0;
  const spotTick=latest.get(`${c.indexName}:spot:${contracts.indices[c.indexName]?.spot?.token||''}`);
  const spot=c.segment==='spot'?n.ltp:(spotTick?.ltp||contracts.indices[c.indexName]?.spotPrice||null);
  const tick={...n,...c,key,priceChange,oiChange,classification:old?classifyOi(priceChange,oiChange):'Insufficient data',spot,
    greeks:c.segment==='option'&&spot&&c.expiry?calculateGreeks({type:c.optionType,spot,strike:Number(c.strike),premium:n.ltp,expiry:c.expiry,riskFreeRate:config.riskFreeRate}):null,
    receivedAt:new Date().toISOString()};
  latest.set(key,tick);
  if(Date.now()-(lastPersist.get(key)||0)>=config.tickPersistIntervalMs){lastPersist.set(key,Date.now());await saveTick(tick).catch(e=>console.error('tick persistence:',e.message));}
  if(old&&(priceChange!==0||oiChange!==0))await saveOiSnapshot(tick).catch(e=>console.error('OI persistence:',e.message));
  emit({type:'tick',data:tick}); emit({type:'dashboard',data:getDashboard()});
}
export function getDashboard() {
  const indices={};
  for(const name of ['NIFTY','BANKNIFTY','SENSEX']) {
    const rows=[...latest.values()].filter(x=>x.indexName===name),options=rows.filter(x=>x.segment==='option'),futures=rows.filter(x=>x.segment==='future');
    const groups={ce:{},pe:{},futures:{}};
    for(const r of options){const side=r.optionType==='CE'?'ce':'pe';groups[side][r.classification]=(groups[side][r.classification]||0)+1;}
    for(const r of futures)groups.futures[r.classification]=(groups.futures[r.classification]||0)+1;
    const idx=contracts.indices[name]||{};
    indices[name]={summary:summarizeOptions(options,futures),groups,options:options.sort((a,b)=>Number(a.strike)-Number(b.strike)),futures,
      spot:rows.find(x=>x.segment==='spot')?.ltp??idx.spotPrice??null,
      contracts:{optionExpiry:idx.optionExpiry||null,futureExpiry:idx.futureExpiry||null,optionCount:idx.options?.length||0,futureCount:idx.futures?.length||0}};
  }
  return {status:'live-if-connected',updatedAt:new Date().toISOString(),instrumentGeneratedAt:contracts.generatedAt||null,indices};
}
export async function startMarketEngine(onStatus=()=>{}) {
  if(socket){try{socket.close();}catch{} socket=null;}
  onStatus({connected:false,started:true,subscribed:0,error:null,phase:'loading-instrument-master'});
  contracts=await buildContracts({getLtp:getAngelLtp});
  const groups=new Map();
  for(const idx of Object.values(contracts.indices))for(const c of [{...idx.spot},...(idx.options||[]),...(idx.futures||[])]){
    const ex=Number(c.exchangeType);if(!groups.has(ex))groups.set(ex,[]);groups.get(ex).push(String(c.token));
  }
  const subscriptions=[...groups].map(([exchangeType,tokens])=>({exchangeType,tokens:[...new Set(tokens)]}));
  const total=subscriptions.reduce((n,x)=>n+x.tokens.length,0);
  if(!total||total>config.maxSubscriptionTokens)throw new Error(`Invalid subscription total ${total}; configured limit ${config.maxSubscriptionTokens}`);
  socket=await connectAngel(onTick,onStatus);subscribeAngel(subscriptions);
  onStatus({connected:true,started:true,subscribed:total,error:null,phase:'subscribed',instruments:getInstrumentSummary()});
  emit({type:'dashboard',data:getDashboard()});return socket;
}
export function getInstrumentSummary(){return Object.fromEntries(Object.entries(contracts.indices||{}).map(([k,v])=>[k,{spot:v.spot?.token||null,optionExpiry:v.optionExpiry||null,futureExpiry:v.futureExpiry||null,options:v.options?.length||0,futures:v.futures?.length||0}]));}
