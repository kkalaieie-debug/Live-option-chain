
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

const latest = new Map();
const clients = new Set();
const lastPersist = new Map();

let contracts = { indices: {} };
let socket = null;

let receivedTicks = 0;
let unmatchedTicks = 0;
let lastTickAt = null;

const keyOf = c =>
  `${c.indexName}:${c.segment}:${c.token}`;

function emit(payload) {
  const message = JSON.stringify(payload);

  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(message);
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
}

// ==========================================
// NORMALIZE ANGEL ONE TICK
// ==========================================

function normalize(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
    console.warn(
      '[feed] Raw binary message received instead of parsed tick object'
    );
    return null;
  }

  // Angel One SDK may return token as:
  // "\"99926000\""
  // Remove surrounding quotation marks and null characters.
  const token = String(
    raw.token ??
    raw.symbolToken ??
    raw.symboltoken ??
    ''
  )
    .replace(/^["']|["']$/g, '')
    .replace(/\0/g, '')
    .trim();

  const rawPrice = Number(
    raw.last_traded_price ??
    raw.ltp ??
    raw.lastTradedPrice
  );

  if (!token || !Number.isFinite(rawPrice) || rawPrice <= 0) {
    return null;
  }

  // Angel One prices are generally transmitted in paise.
  const ltp = rawPrice > 100000
    ? rawPrice / 100
    : rawPrice;

  return {
    token,
    ltp,
    oi: Number(
      raw.open_interest ??
      raw.openInterest ??
      raw.oi ??
      0
    ),
    volume: Number(
      raw.vol_traded ??
      raw.volume_trade_for_the_day ??
      raw.volume ??
      0
    ),
    exchangeTime:
      raw.exchange_timestamp ??
      raw.exchangeTime ??
      null
  };
}

// ==========================================
// FIND CONTRACT BY TOKEN
// ==========================================

function find(token) {
  for (const [indexName, idx] of Object.entries(contracts.indices)) {
    for (const [field, segment] of [
      ['options', 'option'],
      ['futures', 'future']
    ]) {
      const contract = (idx[field] || []).find(
        item => String(item.token) === token
      );

      if (contract) {
        return {
          ...contract,
          indexName,
          segment
        };
      }
    }

    if (String(idx.spot?.token || '') === token) {
      return {
        ...idx.spot,
        indexName,
        segment: 'spot'
      };
    }
  }

  return null;
}

// ==========================================
// PROCESS LIVE TICK
// ==========================================

async function onTick(raw) {
  receivedTicks++;

  const normalized = normalize(raw);

  if (!normalized) {
    if (receivedTicks <= 10) {
      console.warn(
        '[feed] Tick could not be normalized:',
        JSON.stringify(raw).slice(0, 500)
      );
    }
    return;
  }

  const contract = find(normalized.token);

  if (!contract) {
    unmatchedTicks++;

    if (unmatchedTicks <= 10) {
      console.warn(
        `[feed] Received unknown token: ${normalized.token}`
      );
    }

    return;
  }

  lastTickAt = new Date().toISOString();

  const key = keyOf({
    ...contract,
    token: normalized.token
  });

  const old = latest.get(key);

  const priceChange = old
    ? normalized.ltp - old.ltp
    : 0;

  const oiChange = old
    ? normalized.oi - old.oi
    : 0;

  const spotKey =
    `${contract.indexName}:spot:${contracts.indices[contract.indexName]?.spot?.token || ''}`;

  const spotTick = latest.get(spotKey);

  const spot = contract.segment === 'spot'
    ? normalized.ltp
    : (
        spotTick?.ltp ||
        contracts.indices[contract.indexName]?.spotPrice ||
        null
      );

  const tick = {
    ...normalized,
    ...contract,
    key,
    priceChange,
    oiChange,

    classification: old
      ? classifyOi(priceChange, oiChange)
      : 'Insufficient data',

    spot,

    greeks:
      contract.segment === 'option' &&
      spot &&
      contract.expiry
        ? calculateGreeks({
            type: contract.optionType,
            spot,
            strike: Number(contract.strike),
            premium: normalized.ltp,
            expiry: contract.expiry,
            riskFreeRate: config.riskFreeRate
          })
        : null,

    receivedAt: lastTickAt
  };

  latest.set(key, tick);

  // Log the first five matched ticks for verification.
  if (latest.size <= 5) {
    console.log(
      `[feed] Matched tick: ${contract.indexName} ${contract.segment} ${normalized.token} LTP=${normalized.ltp} OI=${normalized.oi}`
    );
  }

  // Persist tick snapshots.
  if (
    Date.now() -
    (lastPersist.get(key) || 0) >=
    config.tickPersistIntervalMs
  ) {
    lastPersist.set(key, Date.now());

    await saveTick(tick).catch(error => {
      console.error(
        '[database] Tick persistence failed:',
        error.message
      );
    });
  }

  // Save OI changes after a previous tick exists.
  if (old && (priceChange !== 0 || oiChange !== 0)) {
    await saveOiSnapshot(tick).catch(error => {
      console.error(
        '[database] OI persistence failed:',
        error.message
      );
    });
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

// ==========================================
// DASHBOARD DATA
// ==========================================

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

    for (const row of options) {
      const side = row.optionType === 'CE'
        ? 'ce'
        : 'pe';

      groups[side][row.classification] =
        (groups[side][row.classification] || 0) + 1;
    }

    for (const row of futures) {
      groups.futures[row.classification] =
        (groups.futures[row.classification] || 0) + 1;
    }

    const idx = contracts.indices[name] || {};

    indices[name] = {
      summary: summarizeOptions(options, futures),

      groups,

      options: options.sort(
        (a, b) => Number(a.strike) - Number(b.strike)
      ),

      futures,

      spot:
        rows.find(item => item.segment === 'spot')?.ltp ??
        idx.spotPrice ??
        null,

      contracts: {
        optionExpiry: idx.optionExpiry || null,
        futureExpiry: idx.futureExpiry || null,
        optionCount: idx.options?.length || 0,
        futureCount: idx.futures?.length || 0
      }
    };
  }

  return {
    status: 'live-if-connected',
    updatedAt: new Date().toISOString(),
    instrumentGeneratedAt: contracts.generatedAt || null,
    tickDiagnostics: {
      received: receivedTicks,
      unmatched: unmatchedTicks,
      matchedInstruments: latest.size,
      lastTickAt
    },
    indices
  };
}

// ==========================================
// START MARKET ENGINE
// ==========================================

export async function startMarketEngine(onStatus = () => {}) {
  if (socket) {
    try {
      socket.close();
    } catch {
      // Ignore previous socket close error.
    }

    socket = null;
  }

  latest.clear();
  lastPersist.clear();

  receivedTicks = 0;
  unmatchedTicks = 0;
  lastTickAt = null;

  onStatus({
    connected: false,
    started: true,
    subscribed: 0,
    error: null,
    phase: 'loading-instrument-master'
  });

  console.log('[TradePulse] Building market contracts');

  contracts = await buildContracts({
    getLtp: getAngelLtp
  });

  const groups = new Map();

  for (const idx of Object.values(contracts.indices)) {
    const instruments = [
      { ...idx.spot },
      ...(idx.options || []),
      ...(idx.futures || [])
    ];

    for (const instrument of instruments) {
      const exchangeType = Number(instrument.exchangeType);

      if (!groups.has(exchangeType)) {
        groups.set(exchangeType, []);
      }

      groups.get(exchangeType).push(
        String(instrument.token)
      );
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
      `Invalid subscription total ${total}; configured limit ${config.maxSubscriptionTokens}`
    );
  }

  console.log(
    `[TradePulse] Total instruments prepared: ${total}`
  );

  socket = await connectAngel(
    onTick,
    onStatus
  );

  subscribeAngel(subscriptions);

  onStatus({
    connected: true,
    started: true,
    subscribed: total,
    error: null,
    phase: 'subscribed',
    instruments: getInstrumentSummary()
  });

  emit({
    type: 'dashboard',
    data: getDashboard()
  });

  return socket;
}

// ==========================================
// INSTRUMENT SUMMARY
// ==========================================

export function getInstrumentSummary() {
  return Object.fromEntries(
    Object.entries(contracts.indices || {}).map(
      ([name, value]) => [
        name,
        {
          spot: value.spot?.token || null,
          optionExpiry: value.optionExpiry || null,
          futureExpiry: value.futureExpiry || null,
          options: value.options?.length || 0,
          futures: value.futures?.length || 0
        }
      ]
    )
  );
}
