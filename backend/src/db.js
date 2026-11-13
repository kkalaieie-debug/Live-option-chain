
import { Pool } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// --------------------------------------------------
// PostgreSQL connection
// --------------------------------------------------

export const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
      statement_timeout: 15000,
      keepAlive: true
    })
  : null;

pool?.on('error', error => {
  console.error('[Database] Pool error:', error.message);
});

// --------------------------------------------------
// Queues: keep the latest value per instrument
// --------------------------------------------------

const tickQueue = new Map();
const oiQueue = new Map();

const MAX_QUEUE = 3000;
const BATCH_SIZE = 50;
const FLUSH_MS = 3000;

let isFlushing = false;
let lastWarning = 0;

function warn(message) {
  if (Date.now() - lastWarning > 30000) {
    lastWarning = Date.now();
    console.error('[Database]', message);
  }
}

function put(queue, item) {
  if (!item?.key) return;

  queue.delete(String(item.key));
  queue.set(String(item.key), item);

  while (queue.size > MAX_QUEUE) {
    queue.delete(queue.keys().next().value);
  }
}

function n(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function dateValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);

  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

// --------------------------------------------------
// Initialize database
// --------------------------------------------------

export async function initDb() {
  if (!pool) {
    console.warn('[Database] DATABASE_URL missing. Persistence disabled.');
    return;
  }

  const connection = await pool.connect();

  try {
    await connection.query('SELECT 1');

    const schema = await fs.readFile(
      path.resolve('db/schema.sql'),
      'utf8'
    );

    await connection.query(schema);

    console.log('[Database] PostgreSQL connected.');
    console.log('[Database] Schema initialization completed.');
  } finally {
    connection.release();
  }
}

// --------------------------------------------------
// Queue tick
// --------------------------------------------------

export async function saveTick(t) {
  if (!pool || !t) return;

  put(tickQueue, {
    key: String(t.key || ''),
    indexName: t.indexName ?? null,
    segment: t.segment ?? null,
    optionType: t.optionType ?? null,
    strike: n(t.strike),
    expiry: t.expiry ?? null,
    ltp: n(t.ltp),
    oi: n(t.oi),
    volume: n(t.volume),
    exchangeTime: dateValue(t.exchangeTime)
  });
}

// --------------------------------------------------
// Queue OI snapshot
// --------------------------------------------------

export async function saveOiSnapshot(s) {
  if (!pool || !s) return;

  put(oiQueue, {
    key: String(s.key || ''),
    indexName: s.indexName ?? null,
    segment: s.segment ?? null,
    optionType: s.optionType ?? null,
    strike: n(s.strike),
    expiry: s.expiry ?? null,
    ltp: n(s.ltp),
    oi: n(s.oi),
    oiChange: n(s.oiChange),
    priceChange: n(s.priceChange),
    classification: s.classification ?? 'Unknown'
  });
}

// --------------------------------------------------
// Batch SQL helper
// --------------------------------------------------

async function insertRows(table, columns, rows) {
  if (!pool || rows.length === 0) return;

  const values = [];
  const groups = [];

  for (const row of rows) {
    const placeholders = [];

    for (const value of row) {
      values.push(value);
      placeholders.push(`$${values.length}`);
    }

    groups.push(`(${placeholders.join(',')})`);
  }

  const sql = `
    INSERT INTO ${table} (${columns.join(',')})
    VALUES ${groups.join(',')}
  `;

  await pool.query(sql, values);
}

// --------------------------------------------------
// Flush a queue
// --------------------------------------------------

async function flushOne(queue, table, columns, mapper) {
  if (queue.size === 0) return;

  const entries = [...queue.entries()].slice(0, BATCH_SIZE);

  for (const [key] of entries) {
    queue.delete(key);
  }

  const rows = entries.map(([, item]) => mapper(item));

  try {
    await insertRows(table, columns, rows);
  } catch (error) {
    // Restore failed items without overwriting newer ticks.
    for (const [key, item] of entries) {
      if (!queue.has(key)) queue.set(key, item);
    }

    warn(`${table} write failed: ${error.message}`);
  }
}

// --------------------------------------------------
// Periodic database writer
// --------------------------------------------------

async function flushQueues() {
  if (!pool || isFlushing) return;

  isFlushing = true;

  try {
    await flushOne(
      tickQueue,
      'ticks',
      [
        'instrument_key',
        'index_name',
        'segment',
        'option_type',
        'strike',
        'expiry',
        'ltp',
        'oi',
        'volume',
        'exchange_time'
      ],
      t => [
        t.key,
        t.indexName,
        t.segment,
        t.optionType,
        t.strike,
        t.expiry,
        t.ltp,
        t.oi,
        t.volume,
        t.exchangeTime
      ]
    );

    await flushOne(
      oiQueue,
      'oi_snapshots',
      [
        'instrument_key',
        'index_name',
        'segment',
        'option_type',
        'strike',
        'expiry',
        'ltp',
        'oi',
        'oi_change',
        'price_change',
        'classification'
      ],
      s => [
        s.key,
        s.indexName,
        s.segment,
        s.optionType,
        s.strike,
        s.expiry,
        s.ltp,
        s.oi,
        s.oiChange,
        s.priceChange,
        s.classification
      ]
    );
  } finally {
    isFlushing = false;
  }
}

const timer = setInterval(() => {
  flushQueues().catch(error => {
    warn(`Flush failed: ${error.message}`);
  });
}, FLUSH_MS);

timer.unref();

// --------------------------------------------------
// History API
// --------------------------------------------------

export async function latestSnapshots(indexName) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT DISTINCT ON (instrument_key) *
     FROM ticks
     WHERE index_name = $1
     ORDER BY instrument_key, received_at DESC`,
    [indexName]
  );

  return result.rows;
}

// --------------------------------------------------
// Queue diagnostics
// --------------------------------------------------

export function getDatabaseQueueStatus() {
  return {
    configured: Boolean(pool),
    pendingTicks: tickQueue.size,
    pendingOi: oiQueue.size,
    flushing: isFlushing
  };
}
