
import speakeasy from 'speakeasy';
import { SmartAPI, WebSocketV2 } from 'smartapi-javascript';
import { config } from './config.js';

let smartApi = null;
let ws = null;
let session = null;

// ==========================================
// LOGIN
// ==========================================

export async function loginAngel() {
  const { apiKey, clientCode, pin, totpSecret } = config.angel;

  if (!apiKey || !clientCode || !pin || !totpSecret) {
    throw new Error('Missing Angel One credentials. Check Render environment variables.');
  }

  console.log('[Angel One] Starting login');

  smartApi = new SmartAPI({ api_key: apiKey });

  const totp = speakeasy.totp({
    secret: totpSecret,
    encoding: 'base32'
  });

  const result = await smartApi.generateSession(clientCode, pin, totp);

  if (!result?.status || !result?.data?.jwtToken) {
    throw new Error(
      `Angel One login failed: ${result?.message || 'Invalid login response'}`
    );
  }

  const feedToken = result.data.feedToken;

  if (!feedToken) {
    throw new Error('Angel One feed token missing from login response.');
  }

  session = {
    jwt: result.data.jwtToken,
    feedToken
  };

  console.log('[Angel One] Login successful');
  console.log('[Angel One] Feed token received');

  return {
    loggedIn: true,
    feedTokenAvailable: true
  };
}

// ==========================================
// LIVE LTP USING ANGEL ONE MARKET DATA API
// ==========================================

export async function getAngelLtp(exchange, tradingsymbol, symboltoken) {
  if (!smartApi) {
    throw new Error('Angel One is not logged in.');
  }

  try {
    const result = await smartApi.marketData({
      mode: 'LTP',
      exchangeTokens: {
        [exchange]: [String(symboltoken)]
      }
    });

    if (!result?.status) {
      throw new Error(
        result?.message || `Market data request failed for ${tradingsymbol}`
      );
    }

    const fetched = result?.data?.fetched || [];

    const quote = fetched.find(
      item => String(item.symbolToken) === String(symboltoken)
    ) || fetched[0];

    if (!quote || quote.ltp === undefined || quote.ltp === null) {
      const reason = result?.data?.unfetched?.[0]?.message;
      throw new Error(
        reason || `No LTP returned for ${tradingsymbol}`
      );
    }

    console.log(
      `[Angel One] LTP received: ${tradingsymbol} = ${quote.ltp}`
    );

    // Keep the response format expected by instruments.js
    return {
      status: true,
      message: result.message || 'SUCCESS',
      data: quote
    };

  } catch (error) {
    console.error(
      `[Angel One] LTP error for ${tradingsymbol}:`,
      error.message
    );

    throw error;
  }
}

// ==========================================
// WEBSOCKET V2 CONNECTION
// ==========================================

export async function connectAngel(onTick, onStatus) {
  if (!session) {
    await loginAngel();
  }

  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn('[Angel One] Previous socket close warning:', error.message);
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

  ws.on('tick', data => {
    onTick(data);
  });

  ws.on('error', error => {
    console.error('[Angel One] WebSocket error:', error);

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
    console.error('[Angel One] WebSocket connection failed:', error);

    onStatus({
      connected: false,
      error: error?.message || String(error),
      phase: 'connection_failed'
    });

    throw error;
  }
}

// ==========================================
// SUBSCRIBE INSTRUMENTS
// Supports grouped and flat instrument formats
// ==========================================

export function subscribeAngel(list) {
  if (!ws) {
    throw new Error('Angel One WebSocket is not connected.');
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('No instruments supplied for subscription.');
  }

  const groups = new Map();

  function addToken(exchangeType, token) {
    const type = Number(exchangeType);
    const value = String(token ?? '').trim();

    if (!Number.isInteger(type) || !value || value === 'undefined') {
      return;
    }

    if (!groups.has(type)) {
      groups.set(type, new Set());
    }

    groups.get(type).add(value);
  }

  for (const item of list) {
    if (!item) continue;

    if (Array.isArray(item.tokens)) {
      for (const token of item.tokens) {
        addToken(item.exchangeType, token);
      }
    } else if (item.token !== undefined) {
      addToken(item.exchangeType, item.token);
    }
  }

  let totalSubscribed = 0;

  for (const [exchangeType, tokenSet] of groups.entries()) {
    const tokens = [...tokenSet];

    if (!tokens.length) continue;

    const request = {
      correlationID: `tradepulse-${exchangeType}`,
      action: 1,
      mode: 3,
      exchangeType,
      tokens
    };

    console.log(
      `[Angel One] Sending subscription: exchangeType=${exchangeType}, tokens=${tokens.length}`
    );

    ws.fetchData(request);

    totalSubscribed += tokens.length;
  }

  console.log(
    `[Angel One] Total subscription requests sent: ${totalSubscribed}`
  );

  if (totalSubscribed === 0) {
    throw new Error('No valid tokens found in subscription data.');
  }

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
      console.warn('[Angel One] Socket close warning:', error.message);
    }
  }

  ws = null;
  session = null;
  smartApi = null;

  console.log('[Angel One] Disconnected');
}
