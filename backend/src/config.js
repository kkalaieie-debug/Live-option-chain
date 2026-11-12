import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();
const cfgPath = path.resolve('config/contracts.json');
const contracts = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath,'utf8')) : JSON.parse(fs.readFileSync(path.resolve('config/contracts.example.json'),'utf8'));
export const config = {
  port: Number(process.env.PORT || 10000),
  databaseUrl: process.env.DATABASE_URL,
  angel: {
    apiKey: process.env.ANGEL_API_KEY, clientCode: process.env.ANGEL_CLIENT_CODE,
    pin: process.env.ANGEL_PIN, totpSecret: process.env.ANGEL_TOTP_SECRET
  },
  instrumentMasterUrl: process.env.INSTRUMENT_MASTER_URL,
  frontendOrigins: (process.env.FRONTEND_ORIGINS || '*').split(',').map(x=>x.trim()),
  autoConnect: process.env.AUTO_CONNECT === 'true',
  subscribeIndexTokens: process.env.SUBSCRIBE_INDEX_TOKENS === 'true',
  riskFreeRate: Number(process.env.RISK_FREE_RATE || 0.065),
  contracts
};
