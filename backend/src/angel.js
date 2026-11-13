
import speakeasy from 'speakeasy';
import { SmartAPI, WebSocketV2 } from 'smartapi-javascript';
import { config } from './config.js';

let smartApi = null;
let ws = null;
let session = null;

export async function loginAngel() {
  const { apiKey, clientCode, pin, totpSecret } = config.angel;

  if (!apiKey || !clientCode || !pin || !totpSecret) {
    throw new Error(
      'Missing Angel One credentials. Check ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN and ANGEL_TOTP_SECRET.'
    );
  }

  console.log('[Angel One] Starting login');

  smartApi = new SmartAPI({ api_key: apiKey });

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
      'Angel One login succeeded but feedToken was missing from the login response.'
    );
  }

  session = {
    jwt: jwtToken,
    feedToken
  };

  console.log('[Angel One] Login successful; feed token received');

  return {
    loggedIn: true,
    feedTokenAvailable: true
  };
}

export async function getAngelLtp(exchange, tradingsymbol, symboltoken) {
  if (!smartApi) {
    throw new Error('Angel One is not logged in.');
  }

  const result = await smartApi.getLtpData({
    exchange,
    tradingsymbol,
    symboltoken: String(symboltoken)
  });

  if (!result?.status) {
    throw new Error(
      result?.message || `LTP request failed for ${tradingsymbol}`
    );
  }

  return result;
}

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

  ws.on('tick', (data) => {
    onTick(data);
  });

  ws.on('error', (error) => {
    console.error('[Angel One] WebSocket error:', error);
    onStatus({
      connected: false,
      error: error?.message || String(error),
      phase: 'websocket_error'
    });
  });

  ws.on('close', () => {
    console.warn('[Angel One] WebSocket closed');
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

export function subscribeAngel(list) {
  if (!ws) {
    throw new Error('Angel One WebSocket is not connected.');
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('No instruments supplied for subscription.');
  }

  const groups = new Map();

  for (const item of list) {
    const exchangeType = Number(item.exchangeType);
    const token = String(item.token);

    if (!groups.has(exchangeType)) {
      groups.set(exchangeType, []);
    }

    groups.get(exchangeType).push(token);
  }

  for (const [exchangeType, tokens] of groups.entries()) {
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
  }

  return {
    subscribed: list.length,
    groups: groups.size
  };
}

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
}
