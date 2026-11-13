import axios from 'axios';
import { config } from './config.js';

let cache = null, loadedAt = 0;
const META = {
  NIFTY: { cash: 'NSE', cashType: 1, fo: 'NFO', foType: 2 },
  BANKNIFTY: { cash: 'NSE', cashType: 1, fo: 'NFO', foType: 2 },
  SENSEX: { cash: 'BSE', cashType: 3, fo: 'BFO', foType: 4 }
};
const up = v => String(v ?? '').trim().toUpperCase();
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
function isoExpiry(v) {
  if (!v) return null;
  const s = up(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/);
  if (!m) return null;
  const mm = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'};
  return `${m[3]}-${mm[m[2]]}-${m[1].padStart(2,'0')}`;
}
const expiryMs = d => new Date(`${d}T15:30:00+05:30`).getTime();
export async function loadInstrumentMaster(force = false) {
  if (cache && !force && Date.now() - loadedAt < config.instrumentMasterTtlMs) return cache;
  const { data } = await axios.get(config.instrumentMasterUrl, { timeout: 45000 });
  if (!Array.isArray(data)) throw new Error('Angel One instrument master response is not a JSON array');
  cache = data; loadedAt = Date.now(); return cache;
}
function nearestExpiry(rows) {
  return [...new Set(rows.map(x => isoExpiry(x.expiry)).filter(Boolean))]
    .filter(d => expiryMs(d) >= Date.now()).sort((a,b) => expiryMs(a)-expiryMs(b))[0] || null;
}
function strikeValue(v) { const n = num(v); return n === null || n < 0 ? null : n / 100; }
async function spotLtp(getLtp, meta, spot) {
  if (!getLtp) return null;
  try {
    const r = await getLtp(meta.cash, spot.symbol, spot.token);
    const v = num(r?.data?.ltp ?? r?.data?.[0]?.ltp ?? r?.ltp);
    return v && v > 100000 ? v / 100 : v;
  } catch (e) { console.warn(`[instruments] spot LTP ${spot.symbol}: ${e.message}`); return null; }
}
export async function buildContracts({ getLtp, forceMaster = false } = {}) {
  const master = await loadInstrumentMaster(forceMaster);
  const out = { indices: {}, generatedAt: new Date().toISOString(), source: 'Angel One OpenAPIScripMaster' };
  for (const name of Object.keys(META)) {
    const m = META[name];
    const spotAliases = {
  NIFTY: ['NIFTY 50', 'NIFTY50'],
  BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'],
  SENSEX: ['SENSEX']
};

const aliases = spotAliases[name];

const spotRow = master.find(x =>
  up(x.exch_seg) === m.cash &&
  up(x.instrumenttype) === 'AMXIDX' &&
  (
    aliases.includes(up(x.symbol)) ||
    aliases.includes(up(x.name))
  )
);
    if (!spotRow) throw new Error(`Spot token not found for ${name} in Angel One master`);
    const spot = { token: String(spotRow.token), symbol: String(spotRow.symbol), exchange: m.cash, exchangeType: m.cashType };
    const ltp = await spotLtp(getLtp, m, spot);
    const optRows = master.filter(x => up(x.name) === name && up(x.exch_seg) === m.fo && up(x.instrumenttype) === 'OPTIDX');
    const optExpiry = nearestExpiry(optRows);
    const expiryRows = optExpiry ? optRows.filter(x => isoExpiry(x.expiry) === optExpiry) : [];
    const strikes = [...new Set(expiryRows.map(x => strikeValue(x.strike)).filter(x => x !== null))].sort((a,b) => a-b);
    let chosen = [];
    if (strikes.length) {
      let mid = ltp > 0 ? strikes.reduce((best,s,i) => Math.abs(s-ltp) < Math.abs(strikes[best]-ltp) ? i : best, 0) : Math.floor(strikes.length/2);
      const half = Math.floor(config.optionStrikeCount/2);
      chosen = strikes.slice(Math.max(0,mid-half), Math.min(strikes.length,mid+half+1));
    }
    const options = expiryRows.filter(x => chosen.includes(strikeValue(x.strike)) && /(?:CE|PE)$/i.test(String(x.symbol))).map(x => ({
      token:String(x.token), tradingSymbol:String(x.symbol), exchangeType:m.foType, exchange:m.fo,
      expiry:optExpiry, strike:strikeValue(x.strike), optionType:up(x.symbol).endsWith('CE')?'CE':'PE', lotSize:Number(x.lotsize)||null
    }));
    const futRows = master.filter(x => up(x.name) === name && up(x.exch_seg) === m.fo && up(x.instrumenttype) === 'FUTIDX');
    const futExpiry = nearestExpiry(futRows);
    const futures = futExpiry ? futRows.filter(x => isoExpiry(x.expiry) === futExpiry).map(x => ({
      token:String(x.token), tradingSymbol:String(x.symbol), exchangeType:m.foType, exchange:m.fo,
      expiry:futExpiry, strike:null, optionType:null, lotSize:Number(x.lotsize)||null
    })) : [];
    out.indices[name] = { exchange:m.cash, spotExchangeType:m.cashType, derivativeExchange:m.fo,
      derivativeExchangeType:m.foType, spot, spotPrice:ltp, optionExpiry:optExpiry, futureExpiry:futExpiry, options, futures };
  }
  const total = Object.values(out.indices).reduce((n,x) => n + 1 + x.options.length + x.futures.length, 0);
  if (total > config.maxSubscriptionTokens) throw new Error(`Generated ${total} tokens; reduce OPTION_STRIKE_COUNT (limit ${config.maxSubscriptionTokens})`);
  return out;
}
