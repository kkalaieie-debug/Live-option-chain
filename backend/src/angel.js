
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
      'Missing Angel One credentials. Check Render environment variables.'
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
      `Angel One login failed: ${result?.message || 'No JWT token received'}`
    );
  }

  const feedResponse = await smartApi.getfeedToken();

  const feedToken =
    feedResponse?.data?.feedToken ||
    feedResponse?.feedToken ||
    feedResponse;

  if (!feedToken || typeof feedToken !== 'string') {
    throw new Error('Angel One feed token was not received');
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

export async function getAngelLtp(
  exchange,
  tradingsymbol,
  symboltoken
) {
  if (!smartApi) {
    throw new Error('Angel One session is not initialized');
  }

  const result = await smartApi.ltpData({
    exchange,
    tradingsymbol,
    symboltoken: String(symboltoken)
  });

  if (!result?.status || !result?.data) {
    throw new Error(
      `LTP request failed for ${tradingsymbol}: ${result?.message || 'No data'}`
    );
  }

  const ltp = Number(result.data.ltp);

  if (!Number.isFinite(ltp) || ltp <= 0) {
    throw new Error(`Invalid LTP received for ${tradingsymbol}`);
  }

  console.log(
    `[Angel One] LTP received: ${tradingsymbol} = ${ltp}`
  );

  return result;
}

export async function connectAngel(onTick, onStatus) {
  if (!session) {
    await loginAngel();
  }

  if (ws) {
    try {
      ws.close();
    } catch {
      // Ignore errors while closing an old connection.
    }
    ws = null;
  }

  console.log('[Angel One] Creating WebSocket V2 connection');

  // IMPORTANT:
  // The SmartAPI JavaScript SDK expects the feed token
  // in the "feedtype" property, not "feedToken".
  ws = new WebSocketV2({
    jwttoken: session.jwt,
    apikey: config.angel.apiKey,
    clientcode: config.angel.clientCode,
    feedtype: session.feedToken
  });

  ws.on('tick', (data) => {
    try {
      onTick(data);
    } catch (error) {
      console.error('[Angel One] Tick handler error:', error);
    }
  });

  ws.on('error', (error) => {
    console.error('[Angel One] WebSocket error:', error?.message || error);
    onStatus?.({
      connected: false,
      error: error?.message || String(error),
      phase: 'websocket-error'
    });
  });

  ws.on('close', () => {
    console.warn('[Angel One] WebSocket closed');
    onStatus?.({
      connected: false,
      phase: 'disconnected'
    });
  });

  try {
    await ws.connect();

    console.log('[Angel One] WebSocket connected');

    onStatus?.({
      connected: true,
      error: null,
      phase: 'connected'
    });

    return ws;
  } catch (error) {
    console.error(
      '[Angel One] WebSocket connection failed:',
      error?.message || error
    );

    onStatus?.({
      connected: false,
      error: error?.message || String(error),
      phase: 'connection-error'
    });

    throw error;
  }
}

export function subscribeAngel(subscriptionGroups) {
  if (!ws) {
    throw new Error('WebSocket is not connected');
  }

  let requestCount = 0;

  for (const group of subscriptionGroups) {
    const exchangeType = Number(group.exchangeType);
    const tokens = [...new Set(
      (group.tokens || []).map(String).filter(Boolean)
    )];

    if (
      !Number.isInteger(exchangeType) ||
      exchangeType < 1 ||
      exchangeType > 5 ||
      tokens.length === 0
    ) {
      console.warn(
        '[Angel One] Skipping invalid subscription:',
        group
      );
      continue;
    }

    const request = {
      correlationID: `tp${Date.now()}${requestCount}`.slice(0, 20),
      action: 1,
      mode: 3,
      exchangeType,
      tokens
    };

    console.log(
      `[Angel One] Sending subscription: exchangeType=${exchangeType}, tokens=${tokens.length}`
    );

    ws.fetchData(request);
    requestCount++;
  }

  console.log(
    `[Angel One] Total subscription requests sent: ${requestCount}`
  );

  return requestCount;
}

export function closeAngel() {
  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.error('[Angel One] Error closing WebSocket:', error);
    }
  }

  ws = null;
  session = null;
  smartApi = null;
}
