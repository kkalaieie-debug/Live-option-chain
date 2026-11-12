const API=(window.TRADEPULSE_CONFIG?.API_BASE||'').replace(/\/$/,'');
let selected='NIFTY',dashboard={indices:{}},socket=null;
const $=id=>document.getElementById(id),fmt=v=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('en-IN',{maximumFractionDigits:2});
const safe=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function connect(){
 if(!API){$('feed').textContent='SET API URL';return;}
 socket=new WebSocket(API.replace(/^http/,'ws')+'/ws');
 socket.onopen=()=>$('feed').textContent='CONNECTED';
 socket.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='dashboard'||m.type==='snapshot'){dashboard=m.data;render();}if(m.type==='tick'){$('updated').textContent='Tick '+new Date(m.data.receivedAt).toLocaleTimeString();}}catch(err){console.error(err)}};
 socket.onclose=()=>{$('feed').textContent='RECONNECTING';$('feed').className='pill offline';setTimeout(connect,3000)};
 socket.onerror=()=>{$('feed').className='pill offline'};
 socket.onopen=()=>{$('feed').className='pill online';$('feed').textContent='LIVE SOCKET'};
}
function counts(obj){return ['Long Buildup','Short Buildup','Long Unwinding','Short Covering'].map(k=>[k,obj?.[k]||0]);}
function render(){
 const d=dashboard.indices?.[selected]; if(!d)return;
 $('ceoi').textContent=fmt(d.summary?.totalCeOi);$('peoi').textContent=fmt(d.summary?.totalPeOi);
 $('pcr').textContent=fmt(d.summary?.pcr);$('maxpain').textContent=fmt(d.summary?.maxPain?.strike);$('spot').textContent=fmt(d.spot);$('sentiment').textContent=d.summary?.sentiment||'—';
 const g=d.groups||{};
 $('buildgrid').innerHTML=[['CALL OPTIONS – CE',g.ce],['PUT OPTIONS – PE',g.pe],['INDEX FUTURES',g.futures]].map(([title,obj])=>`<div class="buildbox"><h3>${title}</h3>${counts(obj).map(([k,v])=>`<div class="buildrow"><span>${k}</span><b>${fmt(v)}</b></div>`).join('')}</div>`).join('');
 const byStrike=new Map();for(const x of d.options||[]){const k=String(x.strike);if(!byStrike.has(k))byStrike.set(k,{});byStrike.get(k)[x.optionType]=x;}
 const rows=[...byStrike.entries()].sort((a,b)=>Number(a[0])-Number(b[0]));
 $('chain').innerHTML=rows.length?rows.map(([strike,p])=>{const c=p.CE||{},q=p.PE||{};return `<tr><td>${fmt(c.oi)}</td><td>${fmt(c.oiChange)}</td><td>${fmt(c.ltp)}</td><td>${fmt(c.greeks?.iv)}</td><td>${fmt(c.greeks?.delta)}</td><td>${fmt(c.greeks?.gamma)}</td><td>${fmt(c.greeks?.intrinsic)}</td><td>${fmt(c.greeks?.timeValue)}</td><td><span class="tag">${safe(c.classification||'—')}</span></td><td>${fmt(strike)}</td><td><span class="tag">${safe(q.classification||'—')}</span></td><td>${fmt(q.greeks?.timeValue)}</td><td>${fmt(q.greeks?.intrinsic)}</td><td>${fmt(q.greeks?.gamma)}</td><td>${fmt(q.greeks?.delta)}</td><td>${fmt(q.greeks?.iv)}</td><td>${fmt(q.ltp)}</td><td>${fmt(q.oiChange)}</td><td>${fmt(q.oi)}</td></tr>`}).join(''):'<tr><td colspan="19" class="empty">Waiting for configured CE/PE contracts and live ticks</td></tr>';
 $('futures').innerHTML=(d.futures||[]).length?d.futures.map(x=>`<tr><td>${safe(x.tradingSymbol||x.token)}</td><td>${fmt(x.ltp)}</td><td>${fmt(x.oi)}</td><td>${fmt(x.oiChange)}</td><td>${fmt(x.priceChange)}</td><td>${safe(x.classification)}</td></tr>`).join(''):'<tr><td colspan="6" class="empty">No futures ticks yet</td></tr>';
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelector('nav button.active')?.classList.remove('active');b.classList.add('active');selected=b.dataset.index;render()});
async function initial(){try{const r=await fetch(API+'/api/dashboard');dashboard=await r.json();render()}catch(e){$('feed').textContent='BACKEND OFFLINE'}connect()}
initial();
