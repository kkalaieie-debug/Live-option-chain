
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const { Pool } = pg;

// -----------------------------------------------------
// DATABASE CONNECTION
// -----------------------------------------------------

export const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,

      // Keep the connection count low on Render.
      max: 2,
      min: 0,

      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      query_timeout: 10000,
      statement_timeout: 10000,

      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    })
  : null;

if (pool) {
  pool.on('error', error => {
    console.error('[Database] Pool error:', error.message);
  });
}

// -----------------------------------------------------
// WRITE QUEUES
// -----------------------------------------------------

const tickQueue = new Map();
const oiQueue = new Map();

const MAX_QUEUE_SIZE = 4000;
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 2500;

let flushing = false;
let lastDatabaseWarning = 0;

function databaseWarning(message) {
  const now = Date.now();

  // Avoid printing hundreds of identical errors.
  if (now - lastDatabaseWarning >= 30000) {
    lastDatabaseWarning = now;
    console.error('[Database]', message);
  }
}

function queueLatest(queue, item) {
  const key = String(item.key || '');

  if (!key) return;

  // Keep only the newest pending value for each instrument.
  queue.set(key, item);

  // Prevent unlimited memory growth if PostgreSQL is unavailable.
  while (queue.size > MAX_QUEUE_SIZE) {
    const oldestKey = queue.keys().next().value;
    queue.delete(oldestKey);
  }
}

function toTimestamp(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const number = Number(value);

    if (!Number.isFinite(number)) return null;

    const milliseconds =
      number < 100000000000 ? number * 1000 : number;

    const date = new Date(milliseconds);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// -----------------------------------------------------
// BATCH INSERT HELPER
// -----------------------------------------------------

async function insertBatch(table, columns, rows) {
  if (!pool || !rows.length) return;

  const values = [];
  const placeholders = [];

  rows.forEach((row, rowIndex) => {
    const rowPlaceholders = [];

    row.forEach((value, columnIndex) => {
      values.push(value);

      const position = rowIndex * columns.length + columnIndex + 1;
      rowPlaceholders.push(`$${position}`);
    });

    placeholders.push(`(${rowPlaceholders.join(',')})`);
  });

  const sql = `
    INSERT INTO ${table} (${columns.join(',')})
    VALUES ${placeholders.join(',')}
  `;

  await pool.query(sql, values);
}

// -----------------------------------------------------
// DATABASE INITIALIZATION
// -----------------------------------------------------

export async function initDb() {
  if (!pool) {
    console.warn('[Database] DATABASE_URL missing. Persistence disabled.');
    return;
  }

  try {
    await pool.query('SELECT 1');

    const schemaPath = path.resolve('db/schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');

    await pool.query(schema);

    console.log('[Database] PostgreSQL connected successfully.');
    console.log('[Database] Database schema initialized.');
  } catch (error) {
    console.error('[Database] Initialization failed:', error.message);
    throw error;
  }
}

// -----------------------------------------------------
// QUEUE TICK
// Called by engine.js for each eligible tick.
// -----------------------------------------------------

export async function saveTick(tick) {
  if (!pool || !tick) return;

  queueLatest(tickQueue, {
    key: tick.key,
    indexName: tick.indexName,
    segment: tick.segment,
    optionType: tick.optionType || null,
    strike: numberOrNull(tick.strike),
    expiry: tick.expiry || null,
    ltp: numberOrNull(tick.ltp),
    oi: numberOrNull(tick.oi),
    volume: numberOrNull(tick.volume),
    exchangeTime: toTimestamp(tick.exchangeTime)
  });
}

// -----------------------------------------------------
// QUEUE OI SNAPSHOT
// -----------------------------------------------------

export async function saveOiSnapshot(snapshot) {
  if (!pool || !snapshot) return;

  queueLatest(oiQueue, {
    key: snapshot.key,
    indexName: snapshot.indexName,
    segment: snapshot.segment,
    optionType: snapshot.optionType || null,
    strike: numberOrNull(snapshot.strike),
    expiry: snapshot.expiry || null,
    ltp: numberOrNull(snapshot.ltp),
    oi: numberOrNull(snapshot.oi),
    oiChange: numberOrNull(snapshot.oiChange),
    priceChange: numberOrNull(snapshot.priceChange),
    classification: snapshot.classification || 'Unknown'
  });
}

// -----------------------------------------------------
// FLUSH ONE QUEUE IN BATCHES
// -----------------------------------------------------

async function flushQueue(queue, table, columns, mapper) {
  if (!pool || queue.size === 0) return;

  const entries = [...queue.entries()].slice(0, BATCH_SIZE);

  for (const [key] of entries) {
    queue.delete(key);
  }

  const rows = entries.map(([, item]) => mapper(item));

  try {
    await insertBatch(table, columns, rows);
  } catch (error) {
    // Restore failed rows unless a newer value is already queued.
    for (const [key, item] of entries) {
      if (!queue.has(key)) {
        queue.set(key, item);
      }
    }

    databaseWarning(`${table} batch write failed: ${error.message}`);
  }
}

// -----------------------------------------------------
// FLUSH BOTH QUEUES
// -----------------------------------------------------

async function flushDatabaseQueues() {
  if (!pool || flushing) return;

  flushing = true;

  try {
    await flushQueue(
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
      item => [
        item.key,
        item.indexName,
        item.segment,
        item.optionType,
        item.strike,
        item.expiry,
        item.ltp,
        item.oi,
        item.volume,
        item.exchangeTime
      ]
    );

    await flushQueue(
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
      item => [
        item.key,
        item.indexName,
        item.segment,
        item.optionType,
        item.strike,
        item.expiry,
        item.ltp,
        item.oi,
        item.oiChange,
        item.priceChange,
        item.classification
      ]
    );
  } finally {
    flushing = false;
  }
}

// Run the batch writer continuously without blocking server startup.
const flushTimer = setInterval(() => {
  flushDatabaseQueues().catch(error => {
    databaseWarning(`Queue flush error: ${error.message}`);
  });
}, FLUSH_INTERVAL_MS);

flushTimer.unref();

// -----------------------------------------------------
// LATEST TICK HISTORY
// -----------------------------------------------------

export async function latestSnapshots(indexName) {
  if (!pool) return [];

  const query = `
    SELECT DISTINCT ON (instrument_key) *
    FROM ticks
    WHERE index_name = $1
    ORDER BY instrument_key, received_at DESC
  `;

  const result = await pool.query(query, [indexName]);

  return result.rows;
}

// -----------------------------------------------------
// DATABASE STATUS
// -----------------------------------------------------

export function getDatabaseQueueStatus() {
  return {
    configured: Boolean(pool),
    tickQueue: tickQueue.size,
    oiQueue: oiQueue.size,
    flushing
  };
}
