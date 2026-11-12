import speakeasy from 'speakeasy';
import { SmartAPI, WebSocketV2 } from 'smartapi-javascript';
import { config } from './config.js';
let smartApi=null,ws=null,session=null;
export async function loginAngel(){
  const {apiKey,clientCode,pin,totpSecret}=config.angel;
  if(!apiKey||!clientCode||!pin||!totpSecret)throw new Error('Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and ANGEL_TOTP_SECRET in Render');
  smartApi=new SmartAPI({api_key:apiKey});
  const totp=speakeasy.totp({secret:totpSecret,encoding:'base32'});
  const result=await smartApi.generateSession(clientCode,pin,totp);
  if(!result?.status||!result?.data?.jwtToken)throw new Error(`Angel One login failed: ${result?.message||'No JWT returned'}`);
  const feed=await smartApi.getfeedToken();const feedToken=feed?.data?.feedToken||feed?.feedToken||feed;
  if(!feedToken)throw new Error('Angel One login succeeded but feed token was not returned');
  session={jwt:result.data.jwtToken,feedToken};return {loggedIn:true,feedTokenAvailable:true};
}
export async function getAngelLtp(exchange,tradingsymbol,symboltoken){if(!smartApi)throw new Error('Angel One session is not initialized');return smartApi.getLtpData({exchange,tradingsymbol,symboltoken:String(symboltoken)});}
export async function connectAngel(onTick,onStatus){
  if(!session)await loginAngel();if(ws){try{ws.close();}catch{}}
  ws=new WebSocketV2({jwttoken:session.jwt,apikey:config.angel.apiKey,clientcode:config.angel.clientCode,feedtype:session.feedToken});
  ws.on('tick',onTick);ws.on('error',e=>onStatus({connected:false,error:e?.message||String(e)}));ws.on('close',()=>onStatus({connected:false,error:'Angel One WebSocket closed'}));
  await ws.connect();onStatus({connected:true});return ws;
}
export function subscribeAngel(list){if(!ws)throw new Error('Angel One WebSocket is not connected');for(const s of list)if(s.tokens?.length)ws.fetchData({correlationID:`tp${Date.now().toString(36)}`.slice(0,10),action:1,mode:3,exchangeType:Number(s.exchangeType),tokens:s.tokens.map(String)});}
