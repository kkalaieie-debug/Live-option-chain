
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { initDb, latestSnapshots } from './db.js';

import {
  addClient,
  getDashboard,
  getInstrumentSummary,
  startMarketEngine
} from './engine.js';

import { loginAngel } from './angel.js';
import { buildContracts } from './instruments.js';

// ============================================
// TRADEPULSE SERVER CONFIGURATION
// ============================================

const app = express();

app.use(express.json({ limit: '1mb' }));

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      config.frontendOrigins.includes('*') ||
      config.frontendOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed'));
  }
}));

// ============================================
// FEED STATUS
// ============================================

let feedStatus = {
  connected: false,
  started: false,
  error: null,
  subscribed: 0,
  phase: 'idle'
};

// ============================================
// ADMIN AUTHENTICATION
// ============================================

function adminOK(req) {
  const expected = Buffer.from(config.adminApiKey || '');
  const supplied = Buffer.from(
    String(req.get('x-tradepulse-admin-key') || '')
  );

  return (
    expected.length > 0 &&
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  );
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'tradepulse-live',
    feed: feedStatus,
    databaseConfigured: Boolean(config.databaseUrl),
    instruments: getInstrumentSummary(),
    now: new Date().toISOString()
  });
});

// ============================================
// DASHBOARD API
// ============================================

app.get('/api/dashboard', (req, res) => {
  res.json(getDashboard());
});

// ============================================
// FEED STATUS API
// ============================================

app.get('/api/status', (req, res) => {
  res.json(feedStatus);
});

// ============================================
// LOADED INSTRUMENT SUMMARY
// ============================================

app.get('/api/instruments', (req, res) => {
  res.json(getInstrumentSummary());
});

// ============================================
// NEW: INSTRUMENT MASTER PREVIEW
// Does not require Angel One login
// ============================================

app.get('/api/instruments/preview', async (req, res) => {
  try {
    console.log('[TradePulse] Loading instrument master preview');

    const result = await buildContracts();

    const indices = {};

    for (const [name, idx] of Object.entries(result.indices)) {
      indices[name] = {
        exchange: idx.exchange,
        spotExchangeType: idx.spotExchangeType,
        derivativeExchange: idx.derivativeExchange,
        derivativeExchangeType: idx.derivativeExchangeType,

        spot: {
          symbol: idx.spot?.symbol || null,
          token: idx.spot?.token || null,
          price: idx.spotPrice ?? null
        },

        optionExpiry: idx.optionExpiry,
        futureExpiry: idx.futureExpiry,

        optionCount: idx.options?.length || 0,
        ceCount: idx.options?.filter(
          x => x.optionType === 'CE'
        ).length || 0,

        peCount: idx.options?.filter(
          x => x.optionType === 'PE'
        ).length || 0,

        futureCount: idx.futures?.length || 0,

        sampleOptions: (idx.options || []).slice(0, 4),

        sampleFutures: (idx.futures || []).slice(0, 2)
      };
    }

    res.json({
      ok: true,
      service: 'tradepulse-live',
      source: result.source,
      generatedAt: result.generatedAt,
      indices
    });

  } catch (error) {
    console.error(
      '[TradePulse] Instrument preview failed:',
      error.message
    );

    res.status(500).json({
      ok: false,
      service: 'tradepulse-live',
      error: error.message
    });
  }
});

// ============================================
// HISTORICAL OI API
// ============================================

app.get('/api/history/:index', async (req, res) => {
  try {
    const index = String(req.params.index || '').toUpperCase();

    const allowed = ['NIFTY', 'BANKNIFTY', 'SENSEX'];

    if (!allowed.includes(index)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid index. Use NIFTY, BANKNIFTY or SENSEX.'
      });
    }

    const rows = await latestSnapshots(index);

    res.json({
      ok: true,
      index,
      count: rows.length,
      data: rows
    });

  } catch (error) {
    console.error('[TradePulse] History error:', error.message);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================
// SECURE ANGEL ONE CONNECTION
// ============================================

app.post('/api/admin/connect', async (req, res) => {

  if (!adminOK(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  try {
    feedStatus = {
      connected: false,
      started: true,
      error: null,
      subscribed: 0,
      phase: 'authenticating'
    };

    // Authenticate Angel One
    await loginAngel();

    feedStatus.phase = 'loading-instruments';

    // Start instrument discovery and WebSocket subscriptions
    await startMarketEngine(status => {
      feedStatus = {
        ...feedStatus,
        ...status
      };
    });

    res.json({
      ok: true,
      message: 'TradePulse market engine started',
      feed: feedStatus,
      instruments: getInstrumentSummary()
    });

  } catch (error) {

    feedStatus = {
      connected: false,
      started: false,
      error: error.message,
      subscribed: 0,
      phase: 'error'
    };

    console.error(
      '[TradePulse] Admin connection failed:',
      error.message
    );

    res.status(500).json({
      ok: false,
      error: error.message,
      feed: feedStatus
    });
  }
});

// ============================================
// HTTP SERVER
// ============================================

const server = http.createServer(app);

// ============================================
// LIVE WEBSOCKET SERVER
// ============================================

const wss = new WebSocketServer({
  server,
  path: '/ws'
});

wss.on('connection', ws => {
  console.log('[TradePulse] Dashboard WebSocket connected');

  addClient(ws);
});

// ============================================
// DATABASE + SERVER STARTUP
// ============================================

await initDb();

const PORT = config.port;

server.listen(PORT, '0.0.0.0', () => {

  console.log('====================================');
  console.log('TRADEPULSE LIVE BACKEND');
  console.log('====================================');
  console.log(`Server listening on port ${PORT}`);
  console.log(`AUTO_CONNECT: ${config.autoConnect}`);
  console.log('PostgreSQL initialization completed');
  console.log('Instrument preview API enabled');
  console.log('Dashboard WebSocket: /ws');
  console.log('====================================');

  // Optional automatic connection
  if (config.autoConnect) {

    if (!config.adminApiKey) {
      console.error(
        '[TradePulse] AUTO_CONNECT disabled: ADMIN_API_KEY missing'
      );
      return;
    }

    loginAngel()
      .then(() => startMarketEngine(status => {
        feedStatus = {
          ...feedStatus,
          ...status
        };
      }))
      .catch(error => {

        feedStatus = {
          connected: false,
          started: false,
          error: error.message,
          subscribed: 0,
          phase: 'error'
        };

        console.error(
          '[TradePulse] Auto-connect failed:',
          error.message
        );
      });
  }
});

// ============================================
// SERVER ERROR HANDLING
// ============================================

server.on('error', error => {
  console.error('[TradePulse] HTTP server error:', error);
});
