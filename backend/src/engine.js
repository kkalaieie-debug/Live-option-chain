if (!instrument) {
  diagnostics.unmatched++;

  if (diagnostics.unmatched <= 10) {
    console.error('[TradePulse DEBUG] Unmatched token:', {
      token: normalized.token,
      tokenType: typeof normalized.token,
      rawTick: JSON.stringify(raw).slice(0, 1000),
      knownTokens: Object.values(contracts.indices)
        .flatMap(index => [
          index.spot?.token,
          ...(index.options || []).map(x => x.token),
          ...(index.futures || []).map(x => x.token)
        ])
        .slice(0, 10)
    });
  }

  return;
}
