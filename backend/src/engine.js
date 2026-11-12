import { config } from './config.js';
import { saveTick, saveOiSnapshot } from './db.js';
import { classifyOi, calculateGreeks, summarizeOptions } from './analytics.js';
import { connectAngel, subscribeAngel } from './angel.js';

const latest=new Map(), previous=new Map(), clients=new Set(), lastPersist=new Map();
const indexState={NIFTY:{},BANKNIFTY:{},SENSEX:{}};
const contracts=config.contracts.indices || {};
const keyOf=c=>`${c.indexName}:${c.segment}:${c.token}`;
function emit(payload){const msg=JSON.stringify(payload); for(const c of clients){if(c.readyState===1)c.send(msg);}}
export function addClient(ws){clients.add(ws);ws.send(JSON.stringify({type:'snapshot',data:getDashboard()}));ws.on('close',()=>clients.delete(ws));}
function normalizeAngelTick(raw) {
  // SDK versions/feed modes may differ. Map SDK decoded fields here if your tick object uses alternate names.
  const token=String(raw.token ?? raw.symbolToken ?? raw.symboltoken ?? '');
  const ltpRaw=raw.last_traded_price ?? raw.ltp ?? raw.lastTradedPrice;
  const ltp=Number(ltpRaw);
  if(!token || !Number.isFinite(ltp)) return null;
  // SmartAPI FULL/SnapQuote LTP may be in paise (integer); SDK decoded data often returns numeric paise.
  const normalizedLtp=ltp>100000 ? ltp/100 : ltp;
  return {token,ltp:normalizedLtp,oi:Number(raw.open_interest ?? raw.openInterest ?? raw.oi ?? 0),
    volume:Number(raw.volume_trade_for_the_day ?? raw.volume ?? raw.tradeVolume ?? 0),
    exchangeTime:raw.exchange_timestamp ?? raw.exchangeTime ?? null,raw};
}
function lookupContract(token){
  for(const [indexName,idx] of Object.entries(contracts)){
    for(const segment of ['options','futures']){
      const c=(idx[segment]||[]).find(x=>String(x.token)===token);
      if(c)return {...c,indexName,segment:segment==='options'?'option':'future'};
    }
    if(String(idx.spot?.token||'')===token)return {token,indexName,segment:'spot',optionType:null};
  }
  return null;
}
async function processTick(raw){
  const n=normalizeAngelTick(raw); if(!n)return;
  const c=lookupContract(n.token); if(!c)return;
  const key=keyOf({...c,token:n.token}),old=latest.get(key);
  const priceChange=old?n.ltp-old.ltp:0,oiChange=old?n.oi-old.oi:0;
  const classification=old?classifyOi(priceChange,oiChange):'Insufficient data';
  const spotTick = latest.get(`${c.indexName}:spot:${contracts[c.indexName]?.spot?.token || ''}`);
  const spot = c.segment === 'spot' ? n.ltp : (spotTick?.ltp || null);
  const greeks = c.segment === 'option' && spot && c.expiry
    ? calculateGreeks({type:c.optionType,spot,strike:Number(c.strike),premium:n.ltp,expiry:c.expiry,riskFreeRate:config.riskFreeRate})
    : null;
  const tick={...n,...c,key,priceChange,oiChange,classification,spot,greeks,receivedAt:new Date().toISOString()};
  latest.set(key,tick);
  const last=lastPersist.get(key)||0;
  if(Date.now()-last>=1000){lastPersist.set(key,Date.now()); await saveTick(tick).catch(e=>console.error('tick persistence:',e.message));}
  if(old && (priceChange!==0||oiChange!==0)){
    const snap={...tick,oiChange,priceChange};
    await saveOiSnapshot(snap).catch(e=>console.error('OI persistence:',e.message));
  }
  emit({type:'tick',data:tick});
  emit({type:'dashboard',data:getDashboard()});
}
export function getDashboard(){
  const indices={};
  for(const name of ['NIFTY','BANKNIFTY','SENSEX']){
    const rows=[...latest.values()].filter(x=>x.indexName===name);
    const opts=rows.filter(x=>x.segment==='option');
    const futures=rows.filter(x=>x.segment==='future');
    const summary=summarizeOptions(opts,futures);
    const groups={ce:{},pe:{},futures:{}};
    for(const r of opts){
      const side=r.optionType==='CE'?'ce':'pe';
      groups[side][r.classification]=(groups[side][r.classification]||0)+1;
    }
    for(const r of futures) groups.futures[r.classification]=(groups.futures[r.classification]||0)+1;
    indices[name]={summary,groups,options:opts.sort((a,b)=>Number(a.strike)-Number(b.strike)),futures,
      spot:rows.find(x=>x.segment==='spot')?.ltp??null};
  }
  return {status:'live-if-connected',updatedAt:new Date().toISOString(),indices};
}
export async function startMarketEngine(onStatus=()=>{}){
  const subscriptions=[];
  for(const [name,idx] of Object.entries(contracts)){
    const derivativeTokens=[...(idx.options||[]),...(idx.futures||[])].filter(c=>c.token);
    if(derivativeTokens.length) {
      const byExchange = new Map();
      for(const c of derivativeTokens) {
        const ex = Number(c.exchangeType ?? idx.exchangeType);
        if(!byExchange.has(ex)) byExchange.set(ex,[]);
        byExchange.get(ex).push(String(c.token));
      }
      for(const [exchangeType,tokens] of byExchange) subscriptions.push({exchangeType,tokens:[...new Set(tokens)]});
    }
    if(config.subscribeIndexTokens && idx.spot?.token) {
      subscriptions.push({exchangeType:Number(idx.spot.exchangeType ?? idx.spotExchangeType ?? 1),tokens:[String(idx.spot.token)]});
    }
  }
  if(!subscriptions.length) throw new Error('No contract tokens configured. Populate backend/config/contracts.json first.');
  const socket=await connectAngel(processTick,onStatus);
  subscribeAngel(subscriptions);
  onStatus({connected:true,subscribed:subscriptions.reduce((n,s)=>n+s.tokens.length,0)});
  return socket;
}
