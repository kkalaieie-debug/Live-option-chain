import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
const { Pool } = pg;
export const pool = config.databaseUrl ? new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
}) : null;
export async function initDb() {
  if (!pool) { console.warn('DATABASE_URL missing: persistence disabled'); return; }
  const sql = await fs.readFile(path.resolve('db/schema.sql'),'utf8');
  await pool.query(sql);
}
export async function saveTick(t) {
  if (!pool) return;
  await pool.query(
   `INSERT INTO ticks(instrument_key,index_name,segment,option_type,strike,expiry,ltp,oi,volume,exchange_time)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
   [t.key,t.indexName,t.segment,t.optionType,t.strike,t.expiry || null,t.ltp,t.oi,t.volume,t.exchangeTime || null]
  );
}
export async function saveOiSnapshot(s) {
  if (!pool) return;
  await pool.query(
   `INSERT INTO oi_snapshots(instrument_key,index_name,segment,option_type,strike,expiry,ltp,oi,oi_change,price_change,classification)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
   [s.key,s.indexName,s.segment,s.optionType,s.strike,s.expiry || null,s.ltp,s.oi,s.oiChange,s.priceChange,s.classification]
  );
}
export async function latestSnapshots(indexName) {
  if (!pool) return [];
  const q = `SELECT DISTINCT ON (instrument_key) * FROM ticks WHERE index_name=$1 ORDER BY instrument_key,received_at DESC`;
  const {rows}=await pool.query(q,[indexName]); return rows;
}
