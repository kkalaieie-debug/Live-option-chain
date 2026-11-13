
import { config } from './config.js';
import { saveTick, saveOiSnapshot } from './db.js';
import {
  classifyOi,
  calculateGreeks,
  summarizeOptions
} from './analytics.js';
import {
  connectAngel,
  subscribeAngel,
  getAngelLtp
} from './angel.js';
import { buildContracts } from './instruments.js';

// =====================================================
// TRADEPULSE LIVE MARKET ENGINE
// =====================================================

const latest = new Map();
const clients = new Set();
const lastPersist = new Map();

// Canonical token -> instrument information
let tokenLookup = new Map();

let contracts = { indices: {} };
let socket = null;

const diagnostics = {
  received: 0,
  unmatched: 0,
  matchedInstruments: 0,
  lastTickAt: null
};

// =====================================================
// TOKEN NORMALIZATION
// =====================================================

function normalizeToken(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value)
    .replace(/\0/g, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function keyOf(instrument) {
  return `${instrument.indexName}:${instrument.segment}:${normalizeToken(instrument.token)}`;
}

// =====================================================
// DASHBOARD CLIENTS
// =====================================================

function emit(payload) {
  const message = JSON.stringify(payload);

  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        console.error('[WebSocket] Send error:', error.message);
      }
    }
  }
}

export function addClient(ws) {
  clients.add(ws);

  ws.send(JSON.stringify({
    type: 'snapshot',
    data: getDashboard()
  }));

  ws.on('close', () => clients.delete(ws));

  ws.on('error', error => {
    console.error('[WebSocket] Client error:', error.message);
    clients.delete(ws);
  });
}

// =====================================================
// NUMBER AND PRICE NORMALIZATION
// =====================================================

function readNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function normalizePrice(raw) {
  const paisePrice = readNumber(raw.last_traded_price);

  if (paisePrice !== null) {
    return paisePrice / 100;
  }

  const fallback = readNumber(
    raw.ltp ?? raw.lastTradedPrice ?? raw.last_traded_price_rupees
  );

  return fallback;
}

// =====================================================
// UNWRAP SDK TICK OBJECTS
// =====================================================

function unwrapTick(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
    console.warn('[TradePulse] Binary tick received instead of parsed object');
    return null;
  }

  // Direct Angel One SDK parsed tick.
  if (
    raw.token !== undefined ||
    raw.symbolToken !== undefined ||
    raw.symboltoken !== undefined
  ) {
    return raw;
  }

  // Some wrappers place the tick inside data.
  if (raw.data && typeof raw.data === 'object') {
    if (Array.isArray(raw.data)) {
      return null;
    }

    return unwrapTick(raw.data);
  }

  // Some wrappers use payload.
  if (raw.payload && typeof raw.payload === 'object') {
    return unwrapTick(raw.payload);
  }

  return null;
}

// =====================================================
// NORMALIZE INCOMING ANGEL ONE TICK
// =====================================================

function normalize(raw) {
  const tick = unwrapTick(raw);

  if (!tick) {
    return null;
  }

  const token = normalizeToken(
    tick.token ??
    tick.symbolToken ??
    tick.symboltoken ??
    tick.instrument_token ??
    tick.instrumentToken
  );

  const ltp = normalizePrice(tick);

  if (!token || ltp === null || ltp <= 0) {
    return null;
  }

  const oi = readNumber(
    tick.open_interest ??
    tick.openInterest ??
    tick.oi
  );

  const volume = readNumber(
    tick.volume_trade_for_the_day ??
    tick.volumeTradedToday ??
    tick.volume ??
    tick.volumeTraded
  );

  return {
    token,
    ltp,
    oi,
    volume,
    exchangeType: readNumber(
      tick.exchange_type ??
      tick.exchangeType
    ),
    exchangeTime:
      tick.exchange_timestamp ??
      tick.exchangeTime ??
      tick.exchangeTimestamp ??
      null,
    rawTick: tick
  };
}

// =====================================================
// BUILD TOKEN LOOKUP
// =====================================================

function buildTokenLookup() {
  const lookup = new Map();

  for (const [indexName, index] of Object.entries(
    contracts.indices || {}
  )) {
    const add = (instrument, segment) => {
      if (!instrument?.token) {
        return;
      }

      const token = normalizeToken(instrument.token);

      if (!token) {
        return;
      }

      lookup.set(token, {
        ...instrument,
        token,
        indexName,
        segment
      });
    };

    add(index.spot, 'spot');

    for (const option of index.options || []) {
      add(option, 'option');
    }

    for (const future of index.futures || []) {
      add(future, 'future');
    }
  }

  tokenLookup = lookup;

  console.log(
    `[TradePulse] Token lookup built: ${tokenLookup.size} instruments`
  );

  if (tokenLookup.size) {
    console.log(
      '[TradePulse] Sample lookup tokens:',
      [...tokenLookup.keys()].slice(0, 10)
    );
  }

  return tokenLookup;
}

function findInstrument(token) {
  return tokenLookup.get(normalizeToken(token)) || null;
}

// =====================================================
// PROCESS A SINGLE TICK
// =====================================================

async function processSingleTick(raw) {
  diagnostics.received++;

  const normalized = normalize(raw);

  if (!normalized) {
    return;
  }

  const instrument = findInstrument(normalized.token);

  if (!instrument) {
    diagnostics.unmatched++;

    // Log only a few samples to avoid flooding Render logs.
    if (diagnostics.unmatched <= 5) {
      console.warn('[TradePulse DEBUG] Unmatched tick:', {
        token: normalized.token,
        exchangeType: normalized.exchangeType,
        knownTokenCount: tokenLookup.size,
        rawTick: JSON.stringify(normalized.rawTick).slice(0, 1200)
      });
    }

    return;
  }

  const key = keyOf({
    ...instrument,
    token: normalized.token
  });

  const old = latest.get(key);

  const currentOi =
    normalized.oi !== null
      ? normalized.oi
      : (old?.oi ?? 0);

  const currentVolume =
    normalized.volume !== null
      ? normalized.volume
      : (old?.volume ?? 0);

  const priceChange = old
    ? normalized.ltp - old.ltp
    : 0;

  const oiChange = old
    ? currentOi - old.oi
    : 0;

  const spotKey = keyOf({
    indexName: instrument.indexName,
    segment: 'spot',
    token: contracts.indices[instrument.indexName]?.spot?.token
  });

  const spotTick = latest.get(spotKey);

  const spot = instrument.segment === 'spot'
    ? normalized.ltp
    : (
        spotTick?.ltp ??
        contracts.indices[instrument.indexName]?.spotPrice ??
        null
      );

  const classification = old
    ? classifyOi(priceChange, oiChange)
    : 'Insufficient data';

  let greeks = null;

  if (
    instrument.segment === 'option' &&
    spot &&
    instrument.expiry
  ) {
    try {
      greeks = calculateGreeks({
        type: instrument.optionType,
        spot,
        strike: Number(instrument.strike),
        premium: normalized.ltp,
        expiry: instrument.expiry,
        riskFreeRate: config.riskFreeRate
      });
    } catch (error) {
      console.error('[TradePulse] Greeks calculation error:', error.message);
    }
  }

  const tick = {
    ...normalized,
    ...instrument,

    key,
    token: normalized.token,

    ltp: normalized.ltp,
    oi: currentOi,
    volume: currentVolume,

    priceChange,
    oiChange,
    classification,

    spot,
    greeks,

    receivedAt: new Date().toISOString()
  };

  // Do not store raw SDK object in the dashboard or database.
  delete tick.rawTick;

  latest.set(key, tick);

  diagnostics.matchedInstruments = latest.size;
  diagnostics.lastTickAt = tick.receivedAt;

  // Log first few successful matches.
  if (diagnostics.matchedInstruments <= 5) {
    console.log('[TradePulse] Matched instrument:', {
      index: instrument.indexName,
      segment: instrument.segment,
      token: normalized.token,
      symbol: instrument.tradingSymbol,
      ltp: normalized.ltp,
      oi: currentOi,
      volume: currentVolume
    });
  }

  // ===================================================
  // DATABASE TICK STORAGE
  // ===================================================

  const now = Date.now();
  const lastSaved = lastPersist.get(key) || 0;

  if (now - lastSaved >= config.tickPersistIntervalMs) {
    lastPersist.set(key, now);

    saveTick(tick).catch(error => {
      console.error(
        '[Database] Tick persistence error:',
        error.message
      );
    });
  }

  // ===================================================
  // OI SNAPSHOT STORAGE
  // ===================================================

  if (
    old &&
    (priceChange !== 0 || oiChange !== 0)
  ) {
    saveOiSnapshot(tick).catch(error => {
      console.error(
        '[Database] OI snapshot error:',
        error.message
      );
    });
  }

  // ===================================================
  // LIVE DASHBOARD UPDATE
  // ===================================================

  emit({
    type: 'tick',
    data: tick
  });

  emit({
    type: 'dashboard',
    data: getDashboard()
  });
}

// =====================================================
// HANDLE TICK EVENTS
// =====================================================

async function onTick(raw) {
  try {
    // Support an array of parsed ticks.
    if (Array.isArray(raw)) {
      for (const item of raw) {
        await processSingleTick(item);
      }
      return;
    }

    await processSingleTick(raw);
  } catch (error) {
    console.error('[TradePulse] Tick processing error:', error);
  }
}

// =====================================================
// DASHBOARD DATA
// =====================================================

export function getDashboard() {
  const indices = {};

  for (const name of [
    'NIFTY',
    'BANKNIFTY',
    'SENSEX'
  ]) {
    const rows = [...latest.values()].filter(
      item => item.indexName === name
    );

    const options = rows.filter(
      item => item.segment === 'option'
    );

    const futures = rows.filter(
      item => item.segment === 'future'
    );

    const groups = {
      ce: {},
      pe: {},
      futures: {}
    };

    for (const option of options) {
      const side =
        option.optionType === 'CE' ? 'ce' : 'pe';

      const classification = option.classification;

      groups[side][classification] =
        (groups[side][classification] || 0) + 1;
    }

    for (const future of futures) {
      const classification = future.classification;

      groups.futures[classification] =
        (groups.futures[classification] || 0) + 1;
    }

    const index = contracts.indices[name] || {};

    const spotRow = rows.find(
      item => item.segment === 'spot'
    );

    const sortedOptions = [...options].sort(
      (a, b) => Number(a.strike) - Number(b.strike)
    );

    indices[name] = {
      summary: summarizeOptions(options, futures),

      groups,

      options: sortedOptions,

      futures,

      spot:
        spotRow?.ltp ??
        index.spotPrice ??
        null,

      contracts: {
        optionExpiry: index.optionExpiry || null,
        futureExpiry: index.futureExpiry || null,
        optionCount: index.options?.length || 0,
        futureCount: index.futures?.length || 0
      }
    };
  }

  return {
    status: 'live-if-connected',

    updatedAt: new Date().toISOString(),

    instrumentGeneratedAt:
      contracts.generatedAt || null,

    tickDiagnostics: {
      received: diagnostics.received,
      unmatched: diagnostics.unmatched,
      matchedInstruments: diagnostics.matchedInstruments,
      lastTickAt: diagnostics.lastTickAt
    },

    indices
  };
}

// =====================================================
// START MARKET ENGINE
// =====================================================

export async function startMarketEngine(
  onStatus = () => {}
) {
  if (socket) {
    try {
      socket.close();
    } catch (error) {
      console.warn(
        '[TradePulse] Previous socket close:',
        error.message
      );
    }

    socket = null;
  }

  onStatus({
    connected: false,
    started: true,
    subscribed: 0,
    error: null,
    phase: 'loading-instrument-master'
  });

  console.log('[TradePulse] Building live contracts');

  contracts = await buildContracts({
    getLtp: getAngelLtp
  });

  // Reset old market state.
  latest.clear();
  lastPersist.clear();

  diagnostics.received = 0;
  diagnostics.unmatched = 0;
  diagnostics.matchedInstruments = 0;
  diagnostics.lastTickAt = null;

  // Build exact token lookup before connecting.
  buildTokenLookup();

  const groups = new Map();

  for (const index of Object.values(contracts.indices || {})) {
    const instruments = [
      ...(index.spot ? [index.spot] : []),
      ...(index.options || []),
      ...(index.futures || [])
    ];

    for (const instrument of instruments) {
      const exchangeType = Number(instrument.exchangeType);
      const token = normalizeToken(instrument.token);

      if (
        !Number.isInteger(exchangeType) ||
        exchangeType < 1 ||
        exchangeType > 5 ||
        !token
      ) {
        continue;
      }

      if (!groups.has(exchangeType)) {
        groups.set(exchangeType, []);
      }

      groups.get(exchangeType).push(token);
    }
  }

  const subscriptions = [...groups].map(
    ([exchangeType, tokens]) => ({
      exchangeType,
      tokens: [...new Set(tokens)]
    })
  );

  const total = subscriptions.reduce(
    (count, group) => count + group.tokens.length,
    0
  );

  if (
    !total ||
    total > config.maxSubscriptionTokens
  ) {
    throw new Error(
      `Invalid subscription total ${total}; ` +
      `configured limit ${config.maxSubscriptionTokens}`
    );
  }

  console.log(
    `[TradePulse] Connecting feed for ${total} instruments`
  );

  socket = await connectAngel(onTick, onStatus);

  const sent = subscribeAngel(subscriptions);

  onStatus({
    connected: true,
    started: true,
    subscribed: total,
    error: null,
    phase: 'subscribed',
    instruments: getInstrumentSummary()
  });

  console.log(
    `[TradePulse] Live subscriptions sent: ${sent}`
  );

  emit({
    type: 'dashboard',
    data: getDashboard()
  });

  return socket;
}

// =====================================================
// INSTRUMENT SUMMARY
// =====================================================

export function getInstrumentSummary() {
  return Object.fromEntries(
    Object.entries(contracts.indices || {}).map(
      ([name, index]) => [
        name,
        {
          spot: index.spot?.token || null,
          optionExpiry: index.optionExpiry || null,
          futureExpiry: index.futureExpiry || null,
          options: index.options?.length || 0,
          futures: index.futures?.length || 0
        }
      ]
    )
  );
}
