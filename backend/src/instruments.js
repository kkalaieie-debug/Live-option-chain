
import axios from 'axios';
import { config } from './config.js';

let cache = null;
let loadedAt = 0;

const META = {
  NIFTY: {
    cash: 'NSE',
    cashType: 1,
    fo: 'NFO',
    foType: 2
  },
  BANKNIFTY: {
    cash: 'NSE',
    cashType: 1,
    fo: 'NFO',
    foType: 2
  },
  SENSEX: {
    cash: 'BSE',
    cashType: 3,
    fo: 'BFO',
    foType: 4
  }
};

const SPOT_ALIASES = {
  NIFTY: ['NIFTY 50', 'NIFTY50'],
  BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'],
  SENSEX: ['SENSEX']
};

const up = v => String(v ?? '').trim().toUpperCase();

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function isoExpiry(v) {
  if (!v) return null;

  const s = up(v);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  const m = s.match(
    /^(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/
  );

  if (!m) return null;

  const mm = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12'
  };

  return `${m[3]}-${mm[m[2]]}-${m[1].padStart(2, '0')}`;
}

const expiryMs = d =>
  new Date(`${d}T15:30:00+05:30`).getTime();

export async function loadInstrumentMaster(force = false) {
  if (
    cache &&
    !force &&
    Date.now() - loadedAt < config.instrumentMasterTtlMs
  ) {
    return cache;
  }

  const { data } = await axios.get(
    config.instrumentMasterUrl,
    { timeout: 45000 }
  );

  if (!Array.isArray(data)) {
    throw new Error(
      'Angel One instrument master response is not a JSON array'
    );
  }

  cache = data;
  loadedAt = Date.now();

  console.log(
    `[instruments] Loaded ${cache.length} master instruments`
  );

  return cache;
}

function nearestExpiry(rows) {
  return [
    ...new Set(
      rows
        .map(x => isoExpiry(x.expiry))
        .filter(Boolean)
    )
  ]
    .filter(d => expiryMs(d) >= Date.now())
    .sort((a, b) => expiryMs(a) - expiryMs(b))[0] || null;
}

function strikeValue(v) {
  const n = num(v);

  if (n === null || n < 0) return null;

  // Angel One instrument master stores index strikes
  // multiplied by 100.
  return n / 100;
}

function extractLtp(response) {
  const candidates = [
    response?.data?.ltp,
    response?.data?.data?.ltp,
    response?.data?.[0]?.ltp,
    response?.data?.[0]?.close,
    response?.ltp,
    response?.data?.close
  ];

  for (const candidate of candidates) {
    const value = num(candidate);

    if (value !== null && value > 0) {
      return value > 100000 ? value / 100 : value;
    }
  }

  return null;
}

async function spotLtp(getLtp, meta, spot) {
  if (!getLtp) {
    throw new Error(
      `No LTP function supplied for ${spot.symbol}`
    );
  }

  try {
    const response = await getLtp(
      meta.cash,
      spot.symbol,
      spot.token
    );

    const value = extractLtp(response);

    if (value === null || value <= 0) {
      console.error(
        `[instruments] Invalid spot LTP response for ${spot.symbol}:`,
        JSON.stringify(response)
      );

      throw new Error(
        `Could not obtain a valid spot LTP for ${spot.symbol}`
      );
    }

    console.log(
      `[instruments] ${spot.symbol} spot LTP: ${value}`
    );

    return value;
  } catch (error) {
    console.error(
      `[instruments] Spot LTP failed for ${spot.symbol}:`,
      error.message
    );

    throw error;
  }
}

function selectNearestStrikes(strikes, spotPrice, count) {
  if (!strikes.length) {
    throw new Error('No valid option strikes found');
  }

  if (!spotPrice || spotPrice <= 0) {
    throw new Error(
      'Cannot select ATM strikes without a valid spot price'
    );
  }

  const requested = Math.max(1, Math.floor(Number(count) || 31));
  const strikeCount = Math.min(requested, strikes.length);

  // Find the strike closest to the actual spot price.
  let atmIndex = 0;
  let smallestDifference = Infinity;

  for (let i = 0; i < strikes.length; i++) {
    const difference = Math.abs(strikes[i] - spotPrice);

    if (difference < smallestDifference) {
      smallestDifference = difference;
      atmIndex = i;
    }
  }

  // Select a window around ATM.
  let start = Math.max(
    0,
    atmIndex - Math.floor(strikeCount / 2)
  );

  let end = start + strikeCount;

  // Shift the window back if it exceeds available strikes.
  if (end > strikes.length) {
    end = strikes.length;
    start = Math.max(0, end - strikeCount);
  }

  const selected = strikes.slice(start, end);

  return {
    selected,
    atm: strikes[atmIndex],
    atmIndex,
    requested,
    available: strikes.length
  };
}

export async function buildContracts({
  getLtp,
  forceMaster = false
} = {}) {
  const master = await loadInstrumentMaster(forceMaster);

  const out = {
    indices: {},
    generatedAt: new Date().toISOString(),
    source: 'Angel One OpenAPIScripMaster'
  };

  for (const name of Object.keys(META)) {
    const meta = META[name];
    const aliases = SPOT_ALIASES[name];

    // ---------------------------------------------
    // FIND INDEX SPOT INSTRUMENT
    // ---------------------------------------------

    const spotRow = master.find(x =>
      up(x.exch_seg) === meta.cash &&
      up(x.instrumenttype) === 'AMXIDX' &&
      (
        aliases.includes(up(x.symbol)) ||
        aliases.includes(up(x.name))
      )
    );

    if (!spotRow) {
      throw new Error(
        `Spot token not found for ${name} in Angel One master`
      );
    }

    const spot = {
      token: String(spotRow.token),
      symbol: String(spotRow.symbol),
      exchange: meta.cash,
      exchangeType: meta.cashType
    };

    // Important: obtain spot price BEFORE selecting strikes.
    const ltp = await spotLtp(getLtp, meta, spot);

    // ---------------------------------------------
    // FIND OPTION EXPIRY
    // ---------------------------------------------

    const optRows = master.filter(x =>
      up(x.name) === name &&
      up(x.exch_seg) === meta.fo &&
      up(x.instrumenttype) === 'OPTIDX' &&
      /(?:CE|PE)$/i.test(String(x.symbol || ''))
    );

    const optExpiry = nearestExpiry(optRows);

    if (!optExpiry) {
      throw new Error(
        `No upcoming option expiry found for ${name}`
      );
    }

    const expiryRows = optRows.filter(
      x => isoExpiry(x.expiry) === optExpiry
    );

    // ---------------------------------------------
    // GET AVAILABLE STRIKES
    // ---------------------------------------------

    const strikes = [
      ...new Set(
        expiryRows
          .map(x => strikeValue(x.strike))
          .filter(x => x !== null)
      )
    ].sort((a, b) => a - b);

    // ---------------------------------------------
    // SELECT STRIKES AROUND ATM
    // ---------------------------------------------

    const selection = selectNearestStrikes(
      strikes,
      ltp,
      config.optionStrikeCount
    );

    const chosen = selection.selected;
    const chosenSet = new Set(chosen);

    // ---------------------------------------------
    // BUILD CE / PE OPTIONS
    // ---------------------------------------------

    const options = expiryRows
      .filter(x =>
        chosenSet.has(strikeValue(x.strike))
      )
      .map(x => ({
        token: String(x.token),
        tradingSymbol: String(x.symbol),
        exchangeType: meta.foType,
        exchange: meta.fo,
        expiry: optExpiry,
        strike: strikeValue(x.strike),
        optionType: up(x.symbol).endsWith('CE')
          ? 'CE'
          : 'PE',
        lotSize: Number(x.lotsize) || null
      }))
      .sort((a, b) => {
        if (a.strike !== b.strike) {
          return a.strike - b.strike;
        }

        return a.optionType.localeCompare(b.optionType);
      });

    // Check CE/PE availability for each selected strike.
    const pairCounts = new Map();

    for (const option of options) {
      pairCounts.set(
        option.strike,
        (pairCounts.get(option.strike) || 0) + 1
      );
    }

    const incompleteStrikes = chosen.filter(
      strike => pairCounts.get(strike) !== 2
    );

    console.log(`[instruments] ${name} selection:`, {
      spot: ltp,
      expiry: optExpiry,
      atm: selection.atm,
      requestedStrikes: selection.requested,
      availableStrikes: selection.available,
      selectedStrikes: chosen.length,
      firstStrike: chosen[0],
      lastStrike: chosen[chosen.length - 1],
      optionContracts: options.length,
      incompleteStrikes
    });

    if (options.length === 0) {
      throw new Error(
        `No CE/PE option contracts selected for ${name}`
      );
    }

    // ---------------------------------------------
    // FIND NEAREST FUTURES EXPIRY
    // ---------------------------------------------

    const futRows = master.filter(x =>
      up(x.name) === name &&
      up(x.exch_seg) === meta.fo &&
      up(x.instrumenttype) === 'FUTIDX'
    );

    const futExpiry = nearestExpiry(futRows);

    const futures = futExpiry
      ? futRows
          .filter(x => isoExpiry(x.expiry) === futExpiry)
          .map(x => ({
            token: String(x.token),
            tradingSymbol: String(x.symbol),
            exchangeType: meta.foType,
            exchange: meta.fo,
            expiry: futExpiry,
            strike: null,
            optionType: null,
            lotSize: Number(x.lotsize) || null
          }))
      : [];

    // ---------------------------------------------
    // SAVE INDEX CONTRACTS
    // ---------------------------------------------

    out.indices[name] = {
      exchange: meta.cash,
      spotExchangeType: meta.cashType,
      derivativeExchange: meta.fo,
      derivativeExchangeType: meta.foType,

      spot,
      spotPrice: ltp,

      optionExpiry: optExpiry,
      futureExpiry: futExpiry,

      atmStrike: selection.atm,
      selectedStrikeCount: chosen.length,
      firstStrike: chosen[0],
      lastStrike: chosen[chosen.length - 1],

      options,
      futures
    };
  }

  // ---------------------------------------------
  // CHECK SUBSCRIPTION LIMIT
  // ---------------------------------------------

  const total = Object.values(out.indices).reduce(
    (count, index) =>
      count +
      1 +
      index.options.length +
      index.futures.length,
    0
  );

  if (total > config.maxSubscriptionTokens) {
    throw new Error(
      `Generated ${total} tokens; reduce OPTION_STRIKE_COUNT (limit ${config.maxSubscriptionTokens})`
    );
  }

  console.log('[instruments] Contract generation complete:', {
    totalSubscriptions: total,
    indices: Object.fromEntries(
      Object.entries(out.indices).map(([name, index]) => [
        name,
        {
          spot: index.spotPrice,
          atm: index.atmStrike,
          expiry: index.optionExpiry,
          strikes: index.selectedStrikeCount,
          first: index.firstStrike,
          last: index.lastStrike,
          options: index.options.length,
          futures: index.futures.length
        }
      ])
    )
  });

  return out;
}
