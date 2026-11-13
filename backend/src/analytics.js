
const EPS = 1e-9;

export function classifyOi(priceChange, oiChange) {
  if (
    !Number.isFinite(priceChange) ||
    !Number.isFinite(oiChange)
  ) return 'Insufficient data';

  if (priceChange > EPS && oiChange > EPS) return 'Long Buildup';
  if (priceChange < -EPS && oiChange > EPS) return 'Short Buildup';
  if (priceChange < -EPS && oiChange < -EPS) return 'Long Unwinding';
  if (priceChange > EPS && oiChange < -EPS) return 'Short Covering';

  return 'Neutral';
}

export function intrinsicValue(type, spot, strike) {
  return type === 'CE'
    ? Math.max(0, spot - strike)
    : Math.max(0, strike - spot);
}

export function normCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1 / (1 + p * x);
  const erf = 1 - (
    (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) *
    t * Math.exp(-x * x)
  );

  return 0.5 * (1 + sign * erf);
}

const pdf = x =>
  Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function blackScholes(type, S, K, T, r, v) {
  const rootT = Math.sqrt(T);
  const d1 = (
    Math.log(S / K) + (r + 0.5 * v * v) * T
  ) / (v * rootT);

  const d2 = d1 - v * rootT;
  const discount = K * Math.exp(-r * T);

  const price = type === 'CE'
    ? S * normCdf(d1) - discount * normCdf(d2)
    : discount * normCdf(-d2) - S * normCdf(-d1);

  const delta = type === 'CE'
    ? normCdf(d1)
    : normCdf(d1) - 1;

  const gamma = pdf(d1) / (S * v * rootT);

  return { price, delta, gamma };
}

export function calculateGreeks({
  type,
  spot,
  strike,
  premium,
  expiry,
  riskFreeRate = 0.065,
  now = new Date()
}) {
  const S = Number(spot);
  const K = Number(strike);
  const L = Number(premium);
  const r = Number(riskFreeRate);

  const intrinsic = intrinsicValue(type, S, K);
  const timeValue = L - intrinsic;

  const T = (
    new Date(`${expiry}T15:30:00+05:30`).getTime() -
    now.getTime()
  ) / (365.25 * 86400000);

  const invalid = reason => ({
    iv: null,
    delta: null,
    gamma: null,
    intrinsic,
    timeValue: Math.max(0, timeValue),
    reason
  });

  if (
    !['CE', 'PE'].includes(type) ||
    !(S > 0 && K > 0 && L > 0 && T > 0) ||
    !Number.isFinite(r)
  ) {
    return invalid('Invalid option inputs or expired contract');
  }

  // Do not generate fake IV when market premium is below intrinsic.
  // This can happen with stale or mismatched spot/option ticks.
  if (timeValue < -0.50) {
    return invalid('Premium below intrinsic value; check live prices');
  }

  if (timeValue <= 0.01) {
    return invalid('Insufficient time value for reliable IV');
  }

  let low = 0.0001;
  let high = 5;
  let volatility = null;

  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const model = blackScholes(type, S, K, T, r, mid);

    if (!Number.isFinite(model.price)) {
      return invalid('IV calculation failed');
    }

    if (model.price > L) {
      high = mid;
    } else {
      low = mid;
    }

    volatility = mid;
  }

  const model = blackScholes(
    type, S, K, T, r, volatility
  );

  if (
    !Number.isFinite(model.delta) ||
    !Number.isFinite(model.gamma) ||
    volatility >= 4.999
  ) {
    return invalid('IV outside calculation limits');
  }

  return {
    iv: volatility * 100,
    delta: model.delta,
    gamma: model.gamma,
    intrinsic,
    timeValue: Math.max(0, timeValue)
  };
}

export function maxPain(options) {
  const strikes = [
    ...new Set(
      options
        .map(x => Number(x.strike))
        .filter(Number.isFinite)
    )
  ].sort((a, b) => a - b);

  if (!strikes.length) return null;

  let best = null;
  let minimumPayout = Infinity;

  for (const settlement of strikes) {
    let payout = 0;

    for (const option of options) {
      const oi = Number(option.oi || 0);
      const strike = Number(option.strike);

      payout += option.optionType === 'CE'
        ? Math.max(0, settlement - strike) * oi
        : Math.max(0, strike - settlement) * oi;
    }

    if (payout < minimumPayout) {
      minimumPayout = payout;
      best = settlement;
    }
  }

  return {
    strike: best,
    estimatedPayout: minimumPayout
  };
}

export function summarizeOptions(rows, futures = []) {
  const ce = rows.filter(x => x.optionType === 'CE');
  const pe = rows.filter(x => x.optionType === 'PE');

  const sumOi = list =>
    list.reduce((sum, x) => sum + Number(x.oi || 0), 0);

  const ceOi = sumOi(ce);
  const peOi = sumOi(pe);

  const pcr = ceOi > 0 ? peOi / ceOi : null;

  const bullishFutures = futures.filter(x =>
    ['Long Buildup', 'Short Covering'].includes(x.classification)
  ).length;

  const bearishFutures = futures.filter(x =>
    ['Short Buildup', 'Long Unwinding'].includes(x.classification)
  ).length;

  const sentimentScore =
    (pcr === null ? 0 :
      pcr >= 1.15 ? 25 :
      pcr <= 0.85 ? -25 : 0) +
    (bullishFutures - bearishFutures) * 10;

  const sentiment =
    sentimentScore >= 20 ? 'Bullish' :
    sentimentScore <= -20 ? 'Bearish' :
    'Neutral';

  return {
    totalCeOi: ceOi,
    totalPeOi: peOi,
    pcr,
    maxPain: maxPain(rows),
    sentiment,
    sentimentScore
  };
}
