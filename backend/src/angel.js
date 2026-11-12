import speakeasy from 'speakeasy';
import { SmartAPI, WebSocketV2 } from 'smartapi-javascript';
import { config } from './config.js';

let smartApi=null, ws=null, session=null;
export async function loginAngel() {
  const {apiKey,clientCode,pin,totpSecret}=config.angel;
  if(!apiKey||!clientCode||!pin||!totpSecret) throw new Error('Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and ANGEL_TOTP_SECRET');
  smartApi=new SmartAPI({api_key:apiKey});
  const totp=speakeasy.totp({secret:totpSecret,encoding:'base32'});
  const result=await smartApi.generateSession(clientCode,pin,totp);
  if(!result?.status || !result?.data?.jwtToken) throw new Error('Angel One login failed: '+(result?.message||'No JWT returned'));
  const feed=await smartApi.getfeedToken();
  session={jwt:result.data.jwtToken,feedToken:feed?.data?.feedToken || feed?.feedToken || feed, generatedAt:Date.now()};
  return {loggedIn:true, feedTokenAvailable:Boolean(session.feedToken)};
}
export async function connectAngel(onTick,onStatus) {
  if(!session) await loginAngel();
  if(ws) { try{ws.close();}catch{} }
  ws=new WebSocketV2({
    jwttoken:session.jwt, apikey:config.angel.apiKey,
    clientcode:config.angel.clientCode, feedtype:session.feedToken
  });
  ws.on('tick',data=>onTick(data));
  ws.on('error',err=>onStatus({connected:false,error:err?.message||String(err)}));
  await ws.connect();
  onStatus({connected:true});
  return ws;
}
export function subscribeAngel(subscriptions) {
  if(!ws) throw new Error('Angel One WebSocket is not connected');
  // subscriptions: [{exchangeType, tokens:[...]}]
  for(const s of subscriptions){
    if(!s.tokens?.length) continue;
    ws.fetchData({
      correlationID:`tp-${Date.now()}-${s.exchangeType}`,
      action:1, mode:3, exchangeType:Number(s.exchangeType),
      tokens:s.tokens.map(String)
    });
  }
}
export function getAngelSessionStatus(){return {connected:Boolean(ws),loggedIn:Boolean(session)};}
