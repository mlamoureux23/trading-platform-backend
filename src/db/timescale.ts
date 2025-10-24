// backend/src/db/timescale.ts
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// TimescaleDB connection pool
let timescalePool: pg.Pool | null = null;

export const connectTimescaleDB = async (): Promise<pg.Pool> => {
  if (timescalePool) {
    return timescalePool;
  }

  try {
    timescalePool = new Pool({
      host: process.env.TIMESCALE_HOST || 'localhost',
      port: parseInt(process.env.TIMESCALE_PORT || '7433'),
      database: process.env.TIMESCALE_DB || 'trading_timeseries',
      user: process.env.TIMESCALE_USER || 'postgres',
      password: process.env.TIMESCALE_PASSWORD || 'postgres',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test connection
    const client = await timescalePool.connect();
    const result = await client.query("SELECT extname FROM pg_extension WHERE extname = 'timescaledb'");

    if (result.rows.length === 0) {
      throw new Error('TimescaleDB extension not found');
    }

    client.release();
    console.log('✓ Connected to TimescaleDB');

    // Handle pool errors
    timescalePool.on('error', (err) => {
      console.error('Unexpected error on idle TimescaleDB client:', err);
    });

    return timescalePool;
  } catch (error) {
    console.error('Failed to connect to TimescaleDB:', error);
    throw error;
  }
};

export const getTimescalePool = (): pg.Pool => {
  if (!timescalePool) {
    throw new Error('TimescaleDB not connected. Call connectTimescaleDB first.');
  }
  return timescalePool;
};

export const closeTimescaleDB = async (): Promise<void> => {
  if (timescalePool) {
    await timescalePool.end();
    timescalePool = null;
    console.log('✓ TimescaleDB connection closed');
  }
};

export interface Candlestick {
  time: Date;
  symbol: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  tradesCount?: number;
}

// Get historical candlesticks from TimescaleDB
export const getCandlesticks = async (
  symbol: string,
  interval: string,
  limit: number = 100
): Promise<Candlestick[]> => {
  const pool = getTimescalePool();

  // Map interval to minutes for query
  const intervalMap: Record<string, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1D': 1440,
    '1W': 10080,
  };

  const minutes = intervalMap[interval];
  if (!minutes) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  try {
    const query = `
      SELECT
        time_bucket($1::interval, time) as time,
        symbol,
        exchange,
        FIRST(open, time) as open,
        MAX(high) as high,
        MIN(low) as low,
        LAST(close, time) as close,
        SUM(volume) as volume,
        SUM(quote_volume) as quote_volume,
        SUM(trades_count) as trades_count
      FROM candlesticks_raw
      WHERE symbol = $2
        AND exchange = 'bitget'
        AND time >= NOW() - ($3 * $1::interval)
      GROUP BY time_bucket($1::interval, time), symbol, exchange
      ORDER BY time ASC
    `;

    const result = await pool.query(query, [
      `${minutes} minutes`,
      symbol,
      limit,
    ]);

    return result.rows.map((row) => ({
      time: row.time,
      symbol: row.symbol,
      exchange: row.exchange,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
      quoteVolume: row.quote_volume ? parseFloat(row.quote_volume) : undefined,
      tradesCount: row.trades_count || undefined,
    }));
  } catch (error) {
    console.error('Failed to get candlesticks:', error);
    throw error;
  }
};
