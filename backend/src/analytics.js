const EPS = 1e-9;
export function classifyOi(priceChange, oiChange) {
  if (!Number.isFinite(priceChange) || !Number.isFinite(oiChange)) return 'Insufficient data';
  if (priceChange > EPS && oiChange > EPS) return 'Long Buildup';
  if (priceChange < -EPS && oiChange > EPS) return 'Short Buildup';
  if (priceChange < -EPS && oiChange < -EPS) return 'Long Unwinding';
  if (priceChange > EPS && oiChange < -EPS) return 'Short Covering';
  return 'Neutral';
}
export function intrinsicValue(type, spot, strike) {
  return type === 'CE' ? Math.max(0, spot-strike) : Math.max(0, strike-spot);
}
export function normCdf(x) {
  const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;
  const sign=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2);
  const t=1/(1+p*x);
  const erf=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return .5*(1+sign*erf);
}
const pdf=x=>Math.exp(-.5*x*x)/Math.sqrt(2*Math.PI);
function bs(type,S,K,T,r,v) {
  const d1=(Math.log(S/K)+(r+.5*v*v)*T)/(v*Math.sqrt(T));
  const d2=d1-v*Math.sqrt(T);
  const disc=K*Math.exp(-r*T);
  const price=type==='CE'?S*normCdf(d1)-disc*normCdf(d2):disc*normCdf(-d2)-S*normCdf(-d1);
  const delta=type==='CE'?normCdf(d1):normCdf(d1)-1;
  const gamma=pdf(d1)/(S*v*Math.sqrt(T));
  return {price,delta,gamma};
}
export function calculateGreeks({type,spot,strike,premium,expiry,riskFreeRate=.065,now=new Date()}) {
  const T=Math.max(0,(new Date(expiry+'T15:30:00+05:30')-now)/(365.25*864e5));
  const ivFloor=intrinsicValue(type,spot,strike);
  const timeValue=Math.max(0,premium-ivFloor);
  if (!(spot>0&&strike>0&&premium>=0&&T>0)) return {iv:null,delta:null,gamma:null,intrinsic:ivFloor,timeValue,reason:'Invalid spot/strike/premium or expired contract'};
  let lo=.0001,hi=5,mid=.2;
  for(let i=0;i<100;i++){
    mid=(lo+hi)/2; const p=bs(type,spot,strike,T,riskFreeRate,mid).price;
    if(p>premium) hi=mid; else lo=mid;
  }
  const model=bs(type,spot,strike,T,riskFreeRate,mid);
  if(!Number.isFinite(model.gamma)) return {iv:null,delta:null,gamma:null,intrinsic:ivFloor,timeValue};
  return {iv:mid*100,delta:model.delta,gamma:model.gamma,intrinsic:ivFloor,timeValue};
}
export function maxPain(options) {
  const strikes=[...new Set(options.map(x=>Number(x.strike)).filter(Number.isFinite))].sort((a,b)=>a-b);
  if(!strikes.length) return null;
  let best=null,min=Infinity;
  for(const settlement of strikes){
    let payout=0;
    for(const o of options){
      const oi=Number(o.oi||0),k=Number(o.strike);
      payout += o.optionType==='CE' ? Math.max(0,settlement-k)*oi : Math.max(0,k-settlement)*oi;
    }
    if(payout<min){min=payout;best=settlement;}
  }
  return {strike:best,estimatedPayout:min};
}
export function summarizeOptions(rows) {
  const ce=rows.filter(x=>x.optionType==='CE'),pe=rows.filter(x=>x.optionType==='PE');
  const sum=a=>a.reduce((s,x)=>s+Number(x.oi||0),0);
  const ceOi=sum(ce),peOi=sum(pe);
  const pcr=ceOi?peOi/ceOi:null;
  // Conservative descriptive label, not a predictive signal.
  const futures=arguments.length>1?arguments[1]:[];
  const futBull=futures.filter(x=>['Long Buildup','Short Covering'].includes(x.classification)).length;
  const futBear=futures.filter(x=>['Short Buildup','Long Unwinding'].includes(x.classification)).length;
  const sentimentScore=(pcr==null?0:(pcr>=1.15?25:pcr<=0.85?-25:0)) + (futBull-futBear)*10;
  const sentiment=sentimentScore>=20?'Bullish':sentimentScore<=-20?'Bearish':'Neutral';
  return {totalCeOi:ceOi,totalPeOi:peOi,pcr,maxPain:maxPain(rows),sentiment,sentimentScore};
}
