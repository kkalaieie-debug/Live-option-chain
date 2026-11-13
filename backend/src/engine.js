
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

let contracts = { indices: {} };
let socket = null;

const diagnostics = {
  received: 0,
  unmatched: 0,
  matchedInstruments: 0,
  lastTickAt: null
};

const keyOf = c =>
  `${c.indexName}:${c.segment}:${c.token}`;

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

// =====================================================
// DASHBOARD WEBSOCKET CLIENTS
// =====================================================

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
// SMARTAPI PRICE NORMALIZATION
// =====================================================

function readNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function normalizePrice(raw) {
  // SmartAPI WebSocket V2 sends last_traded_price
  // in paise. Convert it into rupees.
  if (raw.last_traded_price !== undefined &&
      raw.last_traded_price !== null) {
    const value = readNumber(raw.last_traded_price);
    return value === null ? null : value / 100;
  }

  // Fallback fields are treated as already normalized
  // rupee values.
  const fallback = readNumber(
    raw.ltp ?? raw.lastTradedPrice
  );

  return fallback;
}

// =====================================================
// NORMALIZE INCOMING TICK
// =====================================================

function normalize(raw) {
  if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
    console.warn('[feed] Received undecoded binary tick');
    return null;
  }

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const token = String(
    raw.token ??
    raw.symbolToken ??
    raw.symboltoken ??
    ''
  );

  const ltp = normalizePrice(raw);

  if (!token || ltp === null || ltp < 0) {
    return null;
  }

  const oi = readNumber(
    raw.open_interest ??
    raw.openInterest ??
    raw.oi
  );

  const volume = readNumber(
    raw.volume_trade_for_the_day ??
    raw.volume ??
    raw.volumeTraded
  );

  return {
    token,
    ltp,
    oi,
    volume,
    exchangeTime:
      raw.exchange_timestamp ??
      raw.exchangeTime ??
      raw.exchangeTimestamp ??
      null
  };
}

// =====================================================
// FIND CONTRACT BY TOKEN
// =====================================================

function findInstrument(token) {
  for (const [indexName, index] of
    Object.entries(contracts.indices || {})) {

    for (const [field, segment] of [
      ['options', 'option'],
      ['futures', 'future']
    ]) {
      const instrument = (index[field] || []).find(
        item => String(item.token) === token
      );

      if (instrument) {
        return {
          ...instrument,
          indexName,
          segment
        };
      }
    }

    if (String(index.spot?.token || '') === token) {
      return {
        ...index.spot,
        indexName,
        segment: 'spot'
      };
    }
  }

  return null;
}

// =====================================================
// PROCESS LIVE TICK
// =====================================================

async function onTick(raw) {
  diagnostics.received++;

  const normalized = normalize(raw);

  if (!normalized) {
    return;
  }

  const instrument = findInstrument(normalized.token);

  if (!instrument) {
    diagnostics.unmatched++;
    return;
  }

  const key = keyOf({
    ...instrument,
    token: normalized.token
  });

  const old = latest.get(key);

  // Preserve previous OI and volume if the incoming
  // tick does not contain those fields.
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

  const spotKey =
    `${instrument.indexName}:spot:` +
    `${contracts.indices[instrument.indexName]?.spot?.token || ''}`;

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

  const greeks =
    instrument.segment === 'option' &&
    spot &&
    instrument.expiry
      ? calculateGreeks({
          type: instrument.optionType,
          spot,
          strike: Number(instrument.strike),
          premium: normalized.ltp,
          expiry: instrument.expiry,
          riskFreeRate: config.riskFreeRate
        })
      : null;

  const tick = {
    ...normalized,
    ...instrument,

    key,
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

  // =================================================
  // DATABASE TICK STORAGE
  // =================================================

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

  // =================================================
  // OI SNAPSHOT STORAGE
  // =================================================

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

  // =================================================
  // LIVE DASHBOARD UPDATE
  // =================================================

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

  // Clear previous in-memory market data when rebuilding
  // the subscriptions.
  latest.clear();
  lastPersist.clear();

  diagnostics.received = 0;
  diagnostics.unmatched = 0;
  diagnostics.matchedInstruments = 0;
  diagnostics.lastTickAt = null;

  const groups = new Map();

  for (const index of Object.values(contracts.indices)) {
    const instruments = [
      { ...index.spot },
      ...(index.options || []),
      ...(index.futures || [])
    ];

    for (const instrument of instruments) {
      const exchangeType = Number(instrument.exchangeType);
      const token = String(instrument.token || '');

      if (
        !Number.isInteger(exchangeType) ||
        exchangeType < 1 ||
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

  subscribeAngel(subscriptions);

  onStatus({
    connected: true,
    started: true,
    subscribed: total,
    error: null,
    phase: 'subscribed',
    instruments: getInstrumentSummary()
  });

  console.log(
    `[TradePulse] Live subscriptions sent: ${total}`
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
