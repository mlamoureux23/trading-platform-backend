// backend/src/websocket/aggregator.ts
import { Candle, INTERVAL_TO_MS } from './types.js';

/**
 * CandleAggregator handles aggregating 1-minute candles into higher timeframes
 * Keeps a sliding window of 1m candles and builds higher timeframes on-demand
 */
export class CandleAggregator {
  // Store last 24 hours of 1-minute candles per symbol (1440 candles)
  private oneMinuteCandles: Map<string, Candle[]> = new Map();
  private readonly MAX_1M_CANDLES = 1440; // 24 hours

  /**
   * Process a new 1-minute candle from Redis
   */
  processOneMinuteCandle(symbol: string, candle: Candle): void {
    if (!this.oneMinuteCandles.has(symbol)) {
      this.oneMinuteCandles.set(symbol, []);
    }

    const candles = this.oneMinuteCandles.get(symbol)!;

    // Check if we should update the last candle or add a new one
    const lastCandle = candles[candles.length - 1];
    const candleTime = new Date(candle.time).getTime();

    if (lastCandle && new Date(lastCandle.time).getTime() === candleTime) {
      // Update existing candle (in-progress candle updates)
      candles[candles.length - 1] = candle;
    } else {
      // New candle
      candles.push(candle);

      // Keep only last 24 hours
      if (candles.length > this.MAX_1M_CANDLES) {
        candles.shift();
      }
    }
  }

  /**
   * Get aggregated candle for a specific interval
   */
  getAggregatedCandle(symbol: string, interval: string): Candle | null {
    if (interval === '1m') {
      const candles = this.oneMinuteCandles.get(symbol);
      return candles && candles.length > 0 ? candles[candles.length - 1] : null;
    }

    const intervalMs = INTERVAL_TO_MS[interval];
    if (!intervalMs) {
      return null;
    }

    const candles = this.oneMinuteCandles.get(symbol);
    if (!candles || candles.length === 0) {
      return null;
    }

    // Get the current interval's start time
    const now = new Date();
    const currentIntervalStart = this.getIntervalStart(now, intervalMs);

    // Filter candles that belong to the current interval
    const intervalCandles = candles.filter((candle) => {
      const candleTime = new Date(candle.time).getTime();
      return candleTime >= currentIntervalStart.getTime() && candleTime < currentIntervalStart.getTime() + intervalMs;
    });

    if (intervalCandles.length === 0) {
      return null;
    }

    // Aggregate the candles
    return this.aggregateCandles(intervalCandles, currentIntervalStart);
  }

  /**
   * Initialize candles from historical data (on startup or first subscription)
   */
  initializeCandles(symbol: string, candles: Candle[]): void {
    // Sort by time
    const sortedCandles = [...candles].sort((a, b) =>
      new Date(a.time).getTime() - new Date(b.time).getTime()
    );

    // Keep only last 24 hours worth
    const limit = Math.min(sortedCandles.length, this.MAX_1M_CANDLES);
    this.oneMinuteCandles.set(symbol, sortedCandles.slice(-limit));
  }

  /**
   * Get the start time of the interval that contains the given time
   */
  private getIntervalStart(time: Date, intervalMs: number): Date {
    const timestamp = time.getTime();
    const intervalStart = Math.floor(timestamp / intervalMs) * intervalMs;
    return new Date(intervalStart);
  }

  /**
   * Aggregate multiple 1-minute candles into a single candle
   */
  private aggregateCandles(candles: Candle[], startTime: Date): Candle {
    // Sort by time to ensure correct OHLC
    const sorted = [...candles].sort((a, b) =>
      new Date(a.time).getTime() - new Date(b.time).getTime()
    );

    return {
      time: startTime,
      open: sorted[0].open,
      high: Math.max(...sorted.map(c => c.high)),
      low: Math.min(...sorted.map(c => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((sum, c) => sum + c.volume, 0),
      quoteVolume: sorted.reduce((sum, c) => sum + (c.quoteVolume || 0), 0),
    };
  }

  /**
   * Get all 1-minute candles for a symbol (for debugging)
   */
  getOneMinuteCandles(symbol: string): Candle[] {
    return this.oneMinuteCandles.get(symbol) || [];
  }

  /**
   * Clear candles for a symbol
   */
  clear(symbol: string): void {
    this.oneMinuteCandles.delete(symbol);
  }

  /**
   * Clear all candles
   */
  clearAll(): void {
    this.oneMinuteCandles.clear();
  }
}

// Singleton instance
let aggregator: CandleAggregator | null = null;

export const getCandleAggregator = (): CandleAggregator => {
  if (!aggregator) {
    aggregator = new CandleAggregator();
  }
  return aggregator;
};
