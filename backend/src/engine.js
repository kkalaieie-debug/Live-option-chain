
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

let tokenLookup = new Map();
let fallbackTokenLookup = new Map();

let contracts = { indices: {} };
let socket = null;

const diagnostics = {
  received: 0,
  invalid: 0,
  unmatched: 0,
  matchedInstruments: 0,
  lastTickAt: null
};

const errorLogTimes = new Map();

function logThrottled(key, message, error) {
  const now = Date.now();
  const last = errorLogTimes.get(key) || 0;

  if (now - last > 30000) {
    errorLogTimes.set(key, now);
    console.error(message, error?.message || error || '');
  }
}

function normalizeToken(value) {
  if (value === undefined || value === null) return '';

  return String(value)
    .replace(/\0/g, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function instrumentKey(exchangeType, token) {
  return `${Number(exchangeType)}:${normalizeToken(token)}`;
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

  try {
    ws.send(JSON.stringify({
      type: 'snapshot',
      data: getDashboard()
    }));
  } catch (error) {
    console.error('[WebSocket] Initial snapshot error:', error.message);
  }

  ws.on('close', () => clients.delete(ws));

  ws.on('error', error => {
    console.error('[WebSocket] Client error:', error.message);
    clients.delete(ws);
  });
}

// =====================================================
// NUMBER HELPERS
// =====================================================

function readNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;

    const number = Number(value);

    if (Number.isFinite(number)) return number;
  }

  return null;
}

function unwrapTicks(raw) {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.flatMap(unwrapTicks);
  }

  if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
    diagnostics.invalid++;
    return [];
  }

  if (typeof raw !== 'object') {
    diagnostics.invalid++;
    return [];
  }

  if (
    raw.token !== undefined ||
    raw.symbolToken !== undefined ||
    raw.symboltoken !== undefined
  ) {
    return [raw];
  }

  if (raw.data !== undefined) {
    return unwrapTicks(raw.data);
  }

  if (raw.payload !== undefined) {
    return unwrapTicks(raw.payload);
  }

  diagnostics.invalid++;
  return [];
}

// =====================================================
// NORMALIZE ANGEL ONE TICK
// =====================================================

function normalizeTick(raw) {
  const token = normalizeToken(
    raw.token ??
    raw.symbolToken ??
    raw.symboltoken ??
    raw.instrument_token ??
    raw.instrumentToken
  );

  const exchangeType = readNumber(
    raw.exchange_type,
    raw.exchangeType
  );

  const rawPrice = readNumber(
    raw.last_traded_price,
    raw.lastTradedPrice
  );

  // Angel One WebSocket V2 prices are in paise.
  const ltp = rawPrice !== null
    ? rawPrice / 100
    : readNumber(raw.ltp);

  if (!token || ltp === null || ltp <= 0) {
    return null;
  }

  const oi = readNumber(
    raw.open_interest,
    raw.openInterest,
    raw.opnInterest,
    raw.oi
  );

  const volume = readNumber(
    raw.volume_trade_for_the_day,
    raw.vol_traded,
    raw.volumeTradedToday,
    raw.tradeVolume,
    raw.volumeTraded,
    raw.volume
  );

  const lastTradedQty = readNumber(
    raw.last_traded_quantity,
    raw.lastTradedQuantity,
    raw.lastTradeQty
  );

  const averagePrice = readNumber(
    raw.average_traded_price,
    raw.avg_traded_price,
    raw.avgTradedPrice
  );

  return {
    token,
    exchangeType,
    ltp,
    oi,
    volume,
    lastTradedQty,
    averageTradedPrice:
      averagePrice === null ? null : averagePrice / 100,
    exchangeTime:
      raw.exchange_timestamp ??
      raw.exchangeTimestamp ??
      raw.exchangeTime ??
      null
  };
}

// =====================================================
// BUILD TOKEN LOOKUP
// =====================================================

function buildTokenLookup() {
  const exactLookup = new Map();
  const tokenOnlyLookup = new Map();

  for (const [indexName, index] of Object.entries(
    contracts.indices || {}
  )) {
    const add = (instrument, segment) => {
      if (!instrument?.token) return;

      const token = normalizeToken(instrument.token);
      const exchangeType = Number(instrument.exchangeType);

      if (!token) return;

      const item = {
        ...instrument,
        token,
        exchangeType,
        indexName,
        segment
      };

      if (Number.isInteger(exchangeType)) {
        exactLookup.set(
          instrumentKey(exchangeType, token),
          item
        );
      }

      // Keep token-only fallback for SDK ticks without exchange type.
      if (!tokenOnlyLookup.has(token)) {
        tokenOnlyLookup.set(token, item);
      }
    };

    add(index.spot, 'spot');

    for (const option of index.options || []) {
      add(option, 'option');
    }

    for (const future of index.futures || []) {
      add(future, 'future');
    }
  }

  tokenLookup = exactLookup;
  fallbackTokenLookup = tokenOnlyLookup;

  console.log(
    `[TradePulse] Exact token lookup: ${tokenLookup.size}`
  );

  console.log(
    `[TradePulse] Fallback token lookup: ${fallbackTokenLookup.size}`
  );

  console.log(
    '[TradePulse] Sample tokens:',
    [...tokenLookup.keys()].slice(0, 10)
  );

  return tokenLookup;
}

function findInstrument(tick) {
  if (tick.exchangeType !== null) {
    const exact = tokenLookup.get(
      instrumentKey(tick.exchangeType, tick.token)
    );

    if (exact) return exact;
  }

  return fallbackTokenLookup.get(tick.token) || null;
}

// =====================================================
// DATABASE SAVE HELPERS
// =====================================================

function persistTick(tick) {
  saveTick(tick).catch(error => {
    logThrottled(
      'tick-db',
      '[Database] Tick persistence error:',
      error
    );
  });
}

function persistOi(tick) {
  saveOiSnapshot(tick).catch(error => {
    logThrottled(
      'oi-db',
      '[Database] OI snapshot error:',
      error
    );
  });
}

// =====================================================
// PROCESS SINGLE TICK
// =====================================================

async function processSingleTick(raw) {
  diagnostics.received++;

  const normalized = normalizeTick(raw);

  if (!normalized) {
    diagnostics.invalid++;
    return;
  }

  const instrument = findInstrument(normalized);

  if (!instrument) {
    diagnostics.unmatched++;

    if (diagnostics.unmatched <= 5) {
      console.warn('[TradePulse] Unmatched tick:', {
        token: normalized.token,
        exchangeType: normalized.exchangeType,
        knownTokens: tokenLookup.size
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
      logThrottled(
        'greeks',
        '[TradePulse] Greeks calculation error:',
        error
      );
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

  latest.set(key, tick);

  diagnostics.matchedInstruments = latest.size;
  diagnostics.lastTickAt = tick.receivedAt;

  if (latest.size <= 5) {
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

  // Persist ticks at the configured interval.
  const now = Date.now();
  const lastSaved = lastPersist.get(key) || 0;

  if (now - lastSaved >= config.tickPersistIntervalMs) {
    lastPersist.set(key, now);
    persistTick(tick);
  }

  // Store OI snapshots when price or OI changes.
  if (old && (priceChange !== 0 || oiChange !== 0)) {
    persistOi(tick);
  }

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
// HANDLE ANGEL ONE TICK EVENTS
// =====================================================

async function onTick(raw) {
  try {
    const ticks = unwrapTicks(raw);

    for (const item of ticks) {
      await processSingleTick(item);
    }
  } catch (error) {
    logThrottled(
      'tick-processing',
      '[TradePulse] Tick processing error:',
      error
    );
  }
}

// =====================================================
// DASHBOARD
// =====================================================

export function getDashboard() {
  const indices = {};

  for (const name of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
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
      const side = option.optionType === 'CE' ? 'ce' : 'pe';
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
      spot: spotRow?.ltp ?? index.spotPrice ?? null,
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
    instrumentGeneratedAt: contracts.generatedAt || null,
    tickDiagnostics: {
      received: diagnostics.received,
      invalid: diagnostics.invalid,
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

export async function startMarketEngine(onStatus = () => {}) {
  if (socket) {
    try {
      socket.close();
    } catch (error) {
      console.warn('[TradePulse] Previous socket close:', error.message);
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

  latest.clear();
  lastPersist.clear();

  diagnostics.received = 0;
  diagnostics.invalid = 0;
  diagnostics.unmatched = 0;
  diagnostics.matchedInstruments = 0;
  diagnostics.lastTickAt = null;

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
