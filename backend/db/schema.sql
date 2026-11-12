CREATE TABLE IF NOT EXISTS ticks (
  id BIGSERIAL PRIMARY KEY,
  instrument_key TEXT NOT NULL,
  index_name TEXT NOT NULL,
  segment TEXT NOT NULL,
  option_type TEXT,
  strike NUMERIC,
  expiry DATE,
  ltp NUMERIC NOT NULL,
  oi NUMERIC,
  volume BIGINT,
  exchange_time TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ticks_key_time_idx ON ticks(instrument_key, received_at DESC);
CREATE INDEX IF NOT EXISTS ticks_index_time_idx ON ticks(index_name, received_at DESC);
CREATE TABLE IF NOT EXISTS oi_snapshots (
  id BIGSERIAL PRIMARY KEY,
  instrument_key TEXT NOT NULL,
  index_name TEXT NOT NULL,
  segment TEXT NOT NULL,
  option_type TEXT,
  strike NUMERIC,
  expiry DATE,
  ltp NUMERIC NOT NULL,
  oi NUMERIC,
  oi_change NUMERIC,
  price_change NUMERIC,
  classification TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS oi_snapshots_index_time_idx ON oi_snapshots(index_name, snapshot_at DESC);
