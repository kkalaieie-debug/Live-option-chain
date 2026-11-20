
import { config } from './config.js';
import {
  saveTick,
  saveOiSnapshot,
  flushPendingWrites,
  loadLatestTickBaselines,
  loadMinuteTickBaselines
} from './db.js';
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
const lastOiPersist = new Map();
const minuteBaselines = new Map();

const OI_SNAPSHOT_INTERVAL_MS = 60_000;

let tokenLookup = new Map();
let fallbackTokenLookup = new Map();

let contracts = { indices: {} };
let socket = null;

const diagnostics = {
  received: 0,
  validTicks: 0,
  invalid: 0,
  invalidReasons: {},
  ignoredPayloads: 0,
  ignoredReasons: {},
  unmatched: 0,
  matchedInstruments: 0,
  lastTickAt: null,
  lastInvalidAt: null,
  lastInvalidReason: null
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

function countReason(bucket, reason) {
  bucket[reason] = (bucket[reason] || 0) + 1;
}

function recordIgnoredPayload(reason, raw) {
  diagnostics.ignoredPayloads++;
  countReason(diagnostics.ignoredReasons, reason);

  const count = diagnostics.ignoredReasons[reason];

  if (count <= 2) {
    const keys = raw && typeof raw === 'object' && !Buffer.isBuffer(raw)
      ? Object.keys(raw).slice(0, 20)
      : [];

    console.warn('[TradePulse] Ignored non-tick WebSocket payload:', {
      reason,
      count,
      type: Buffer.isBuffer(raw) ? 'Buffer' : typeof raw,
      keys
    });
  }
}

function unwrapTicks(raw) {
  if (raw === undefined || raw === null) {
    recordIgnoredPayload('empty_payload', raw);
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.flatMap(unwrapTicks);
  }

  if (
    Buffer.isBuffer(raw) ||
    raw instanceof ArrayBuffer ||
    ArrayBuffer.isView(raw)
  ) {
    recordIgnoredPayload('binary_payload', raw);
    return [];
  }

  if (typeof raw !== 'object') {
    recordIgnoredPayload('non_object_payload', raw);
    return [];
  }

  if (
    raw.token !== undefined ||
    raw.symbolToken !== undefined ||
    raw.symboltoken !== undefined ||
    raw.instrument_token !== undefined ||
    raw.instrumentToken !== undefined
  ) {
    return [raw];
  }

  if (raw.data !== undefined) {
    return unwrapTicks(raw.data);
  }

  if (raw.payload !== undefined) {
    return unwrapTicks(raw.payload);
  }

  recordIgnoredPayload('object_without_tick_fields', raw);
  return [];
}

function getInvalidTickReason(raw) {
  const token = normalizeToken(
    raw?.token ??
    raw?.symbolToken ??
    raw?.symboltoken ??
    raw?.instrument_token ??
    raw?.instrumentToken
  );

  if (!token) return 'missing_token';

  const rawPrice = readNumber(
    raw?.last_traded_price,
    raw?.lastTradedPrice
  );

  const ltp = rawPrice !== null
    ? rawPrice / 100
    : readNumber(raw?.ltp);

  if (ltp === null) return 'missing_or_non_numeric_price';
  if (ltp <= 0) return 'non_positive_price';

  return 'normalization_failed';
}

function recordInvalidTick(raw) {
  diagnostics.invalid++;

  const reason = getInvalidTickReason(raw);
  countReason(diagnostics.invalidReasons, reason);

  diagnostics.lastInvalidAt = new Date().toISOString();
  diagnostics.lastInvalidReason = reason;

  const count = diagnostics.invalidReasons[reason];

  if (count <= 3) {
    console.warn('[TradePulse] Invalid market tick:', {
      reason,
      count,
      keys: raw && typeof raw === 'object'
        ? Object.keys(raw).slice(0, 20)
        : [],
      token: raw?.token ?? raw?.symbolToken ?? raw?.symboltoken ?? null,
      last_traded_price: raw?.last_traded_price ?? raw?.lastTradedPrice ?? null,
      ltp: raw?.ltp ?? null
    });
  }
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
    recordInvalidTick(raw);
    return;
  }

  diagnostics.validTicks++;

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

  // Missing OI is unknown, not zero.
  const currentOi = normalized.oi !== null
    ? normalized.oi
    : (old?.oi ?? null);

  const currentVolume = normalized.volume !== null
    ? normalized.volume
    : (old?.volume ?? null);

  // Restored rows are not considered fresh live tick baselines.
  const hasLivePrevious = Boolean(old && !old.isRestored);

  const tickPriceChange =
    hasLivePrevious && normalized.ltp !== null && old.ltp !== null
      ? normalized.ltp - old.ltp
      : null;

  const tickOiChange =
    hasLivePrevious && currentOi !== null && old.oi !== null
      ? currentOi - old.oi
      : null;

  const tickClassification =
    tickPriceChange !== null && tickOiChange !== null
      ? classifyOi(tickPriceChange, tickOiChange)
      : 'Insufficient data';

  // One-minute comparison baseline.
  let minuteState = minuteBaselines.get(key);

  if (!minuteState) {
    minuteState = {
      baseline: null,
      classification: 'Insufficient data',
      oiChange: null,
      priceChange: null
    };
  }

  const now = Date.now();

  if (
    minuteState.baseline &&
    now - minuteState.baseline.at >= 60_000
  ) {
    const base = minuteState.baseline;

    if (
      currentOi !== null &&
      base.oi !== null &&
      normalized.ltp !== null &&
      base.ltp !== null
    ) {
      minuteState.oiChange = currentOi - base.oi;
      minuteState.priceChange = normalized.ltp - base.ltp;

      minuteState.classification = classifyOi(
        minuteState.priceChange,
        minuteState.oiChange
      );
    } else {
      minuteState.oiChange = null;
      minuteState.priceChange = null;
      minuteState.classification = 'Insufficient data';
    }

    minuteState.baseline = {
      ltp: normalized.ltp,
      oi: currentOi,
      at: now
    };
  } else if (!minuteState.baseline) {
    minuteState.baseline = {
      ltp: normalized.ltp,
      oi: currentOi,
      at: now
    };
  }

  minuteBaselines.set(key, minuteState);

  // Keep existing dashboard field names compatible.
  const priceChange = tickPriceChange;
  const oiChange = tickOiChange;
  const classification = tickClassification;

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
    isRestored: false,
    token: normalized.token,
    ltp: normalized.ltp,
    oi: currentOi,
    volume: currentVolume,
    priceChange,
    oiChange,
    classification,
    tickPriceChange,
    tickOiChange,
    tickClassification,
    minutePriceChange: minuteState.priceChange,
    minuteOiChange: minuteState.oiChange,
    minuteClassification: minuteState.classification,
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
  const lastSaved = lastPersist.get(key) || 0;

  if (now - lastSaved >= config.tickPersistIntervalMs) {
    lastPersist.set(key, now);
    persistTick(tick);
  }

  // Persist first baseline, changes, and periodic refreshes.
  const lastOiSaved = lastOiPersist.get(key) || 0;
  const oiChanged = hasLivePrevious &&
    (priceChange !== 0 || oiChange !== 0);

  if (
    !old ||
    oiChanged ||
    now - lastOiSaved >= OI_SNAPSHOT_INTERVAL_MS
  ) {
    lastOiPersist.set(key, now);
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
