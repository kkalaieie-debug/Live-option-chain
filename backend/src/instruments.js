import axios from 'axios';
import { config } from './config.js';
let masterCache = null, loadedAt = 0;
export async function loadInstrumentMaster(force=false) {
  if(masterCache && !force && Date.now()-loadedAt<6*60*60*1000) return masterCache;
  const url=config.instrumentMasterUrl;
  if(!url) throw new Error('INSTRUMENT_MASTER_URL not configured');
  const {data}=await axios.get(url,{timeout:30000});
  if(!Array.isArray(data)) throw new Error('Unexpected instrument master response');
  masterCache=data; loadedAt=Date.now(); return data;
}
export async function findInstrument(query) {
  const data=await loadInstrumentMaster();
  const q=String(query).toUpperCase();
  return data.filter(x=>String(x.symbol||'').toUpperCase().includes(q)||String(x.name||'').toUpperCase().includes(q));
}
