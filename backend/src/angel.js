
import speakeasy from 'speakeasy';
import { SmartAPI, WebSocketV2 } from 'smartapi-javascript';
import { config } from './config.js';

let smartApi = null;
let ws = null;
let session = null;

// ==========================================
// ANGEL ONE LOGIN
// ==========================================

export async function loginAngel() {
  const {
    apiKey,
    clientCode,
    pin,
    totpSecret
  } = config.angel;

  if (!apiKey || !clientCode || !pin || !totpSecret) {
    throw new Error(
      'Missing Angel One credentials. Check Render environment variables.'
    );
  }

  console.log('[Angel One] Starting login');

  smartApi = new SmartAPI({
    api_key: apiKey
  });

  const totp = speakeasy.totp({
    secret: totpSecret,
    encoding: 'base32'
  });

  const result = await smartApi.generateSession(
    clientCode,
    pin,
    totp
  );

  if (!result?.status || !result?.data?.jwtToken) {
    throw new Error(
      `Angel One login failed: ${result?.message || 'Invalid login response'}`
    );
  }

  const jwtToken = result.data.jwtToken;
  const feedToken = result.data.feedToken;

  if (!feedToken) {
    throw new Error(
      'Login succeeded, but feed token was missing.'
    );
  }

  session = {
    jwt: jwtToken,
    feedToken: feedToken
  };

  console.log('[Angel One] Login successful');
  console.log('[Angel One] Feed token received');

  return {
    loggedIn: true,
    feedTokenAvailable: true
  };
}

// ==========================================
// GET LIVE SPOT / OPTION LTP
// ==========================================

export async function getAngelLtp(
  exchange,
  tradingsymbol,
  symboltoken
) {
  if (!smartApi) {
    throw new Error('Angel One is not logged in.');
  }

  try {
    const result = await smartApi.ltpData(
      exchange,
      tradingsymbol,
      String(symboltoken)
    );

    if (!result?.status) {
      throw new Error(
        result?.message || 'Angel One LTP request failed.'
      );
    }

    return result;

  } catch (error) {
    console.error(
      `[Angel One] LTP error for ${tradingsymbol}:`,
      error.message
    );

    throw error;
  }
}

// ==========================================
// CONNECT ANGEL ONE WEBSOCKET V2
// ==========================================

export async function connectAngel(onTick, onStatus) {
  if (!session) {
    await loginAngel();
  }

  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn(
        '[Angel One] Previous socket close warning:',
        error.message
      );
    }

    ws = null;
  }

  console.log('[Angel One] Creating WebSocket V2 connection');

  ws = new WebSocketV2({
    jwttoken: session.jwt,
    apikey: config.angel.apiKey,
    clientcode: config.angel.clientCode,
    feedtype: session.feedToken
  });

  ws.on('tick', (data) => {
    onTick(data);
  });

  ws.on('error', (error) => {
    console.error(
      '[Angel One] WebSocket error:',
      error
    );

    onStatus({
      connected: false,
      error: error?.message || String(error),
      phase: 'websocket_error'
    });
  });

  ws.on('close', () => {
    console.warn('[Angel One] WebSocket disconnected');

    onStatus({
      connected: false,
      phase: 'disconnected'
    });
  });

  try {
    await ws.connect();

    console.log('[Angel One] WebSocket connected');

    onStatus({
      connected: true,
      phase: 'connected'
    });

    return ws;

  } catch (error) {
    console.error(
      '[Angel One] WebSocket connection failed:',
      error
    );

    onStatus({
      connected: false,
      error: error?.message || String(error),
      phase: 'connection_failed'
    });

    throw error;
  }
}

// ==========================================
// SUBSCRIBE MARKET INSTRUMENTS
// ==========================================

export function subscribeAngel(list) {
  if (!ws) {
    throw new Error(
      'Angel One WebSocket is not connected.'
    );
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      'No instruments supplied for subscription.'
    );
  }

  const groups = new Map();

  for (const item of list) {
    const exchangeType = Number(item.exchangeType);
    const token = String(item.token);

    if (!Number.isInteger(exchangeType) || !token || token === 'undefined') {
      console.warn(
        '[Angel One] Skipping invalid instrument:',
        item
      );
      continue;
    }

    if (!groups.has(exchangeType)) {
      groups.set(exchangeType, new Set());
    }

    groups.get(exchangeType).add(token);
  }

  let totalSubscribed = 0;

  for (const [exchangeType, tokenSet] of groups.entries()) {
    const tokens = [...tokenSet];

    if (tokens.length === 0) {
      continue;
    }

    const request = {
      correlationID: `tradepulse-${exchangeType}`,
      action: 1,
      mode: 3,
      exchangeType,
      tokens
    };

    console.log(
      `[Angel One] Subscribing exchangeType=${exchangeType}, tokens=${tokens.length}`
    );

    ws.fetchData(request);

    totalSubscribed += tokens.length;
  }

  console.log(
    `[Angel One] Total subscription requests sent: ${totalSubscribed}`
  );

  return {
    subscribed: totalSubscribed,
    groups: groups.size
  };
}

// ==========================================
// DISCONNECT
// ==========================================

export function disconnectAngel() {
  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn(
        '[Angel One] Socket close warning:',
        error.message
      );
    }
  }

  ws = null;
  session = null;
  smartApi = null;

  console.log('[Angel One] Disconnected');
}
