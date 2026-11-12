import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { initDb, latestSnapshots } from './db.js';
import { addClient, getDashboard, startMarketEngine } from './engine.js';
import { loginAngel } from './angel.js';

const app=express(); app.use(express.json({limit:'1mb'}));
app.use(cors({origin:(origin,cb)=>{
  if(!origin || config.frontendOrigins.includes('*') || config.frontendOrigins.includes(origin)) return cb(null,true);
  return cb(new Error('Origin not allowed'));
}}));
let feedStatus={connected:false,started:false,error:null,subscribed:0};
app.get('/health',(req,res)=>res.json({ok:true,service:'tradepulse-live',feed:feedStatus,now:new Date().toISOString()}));
app.get('/api/dashboard',(req,res)=>res.json(getDashboard()));
app.get('/api/status',(req,res)=>res.json(feedStatus));
app.get('/api/history/:index',(req,res)=>latestSnapshots(req.params.index.toUpperCase()).then(rows=>res.json(rows)).catch(e=>res.status(500).json({error:e.message})));
app.post('/api/admin/connect',async(req,res)=>{
  try{await loginAngel(); const s=await startMarketEngine(s=>feedStatus={...feedStatus,...s,started:true}); res.json({ok:true,feed:feedStatus});}
  catch(e){feedStatus={connected:false,started:false,error:e.message};res.status(500).json({ok:false,error:e.message});}
});
const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',ws=>addClient(ws));
const port=config.port;
await initDb();
server.listen(port,'0.0.0.0',async()=>{
  console.log(`TradePulse backend listening on ${port}`);
  if(config.autoConnect){
    try{await startMarketEngine(s=>feedStatus={...feedStatus,...s,started:true});}
    catch(e){feedStatus={connected:false,started:false,error:e.message};console.error('Market engine:',e.message);}
  }
});
