import fs from 'node:fs';import path from 'node:path';import dotenv from 'dotenv';dotenv.config();
const cp=path.resolve('config/contracts.json'),ep=path.resolve('config/contracts.example.json');
const contracts=fs.existsSync(cp)?JSON.parse(fs.readFileSync(cp,'utf8')):JSON.parse(fs.readFileSync(ep,'utf8'));
export const config={port:Number(process.env.PORT||10000),databaseUrl:process.env.DATABASE_URL,
 angel:{apiKey:process.env.ANGEL_API_KEY,clientCode:process.env.ANGEL_CLIENT_CODE,pin:process.env.ANGEL_PIN,totpSecret:process.env.ANGEL_TOTP_SECRET},
 adminApiKey:process.env.ADMIN_API_KEY,
 instrumentMasterUrl:process.env.INSTRUMENT_MASTER_URL||'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json',
 instrumentMasterTtlMs:Number(process.env.INSTRUMENT_MASTER_TTL_MS||21600000),optionStrikeCount:Math.max(5,Math.min(101,Number(process.env.OPTION_STRIKE_COUNT||31))),
 maxSubscriptionTokens:Math.max(100,Math.min(1000,Number(process.env.MAX_SUBSCRIPTION_TOKENS||950))),tickPersistIntervalMs:Math.max(250,Number(process.env.TICK_PERSIST_INTERVAL_MS||1000)),
 frontendOrigins:(process.env.FRONTEND_ORIGINS||'*').split(',').map(x=>x.trim()).filter(Boolean),autoConnect:process.env.AUTO_CONNECT==='true',riskFreeRate:Number(process.env.RISK_FREE_RATE||0.065),contracts};
