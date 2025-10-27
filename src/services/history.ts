// backend/src/services/history.ts
import { getCandlesticks } from '../db/timescale.js';
import { Candle } from '../types/websocket.js';
import { getCandleAggregator } from './aggregator.js';

/**
 * HistoryService handles fetching historical candle data from TimescaleDB
 */
export class HistoryService {
  /**
   * Get historical candles for a symbol and interval
   * Also initializes the aggregator with 1m candles if fetching 1m data
   */
  async getHistoricalCandles(
    symbol: string,
    interval: string,
    limit: number = 100
  ): Promise<Candle[]> {
    try {
      console.log(`[History] Fetching ${limit} ${interval} candles for ${symbol}`);

      const candles = await getCandlesticks(symbol, interval, limit);

      // Convert to our Candle format
      const formattedCandles: Candle[] = candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        quoteVolume: c.quoteVolume,
      }));

      // If fetching 1m candles, initialize the aggregator
      if (interval === '1m' && formattedCandles.length > 0) {
        const aggregator = getCandleAggregator();
        aggregator.initializeCandles(symbol, formattedCandles);
        console.log(
          `[History] Initialized aggregator with ${formattedCandles.length} 1m candles for ${symbol}`
        );
      }

      // If fetching higher timeframe but aggregator is empty, fetch 1m candles to populate it
      if (interval !== '1m') {
        const aggregator = getCandleAggregator();
        const oneMinCandles = aggregator.getOneMinuteCandles(symbol);

        if (oneMinCandles.length === 0) {
          console.log(
            `[History] Aggregator empty, fetching 1m candles to populate for ${symbol}`
          );

          // Fetch last 1440 1m candles (24 hours)
          const oneMinData = await getCandlesticks(symbol, '1m', 1440);
          const formatted1m: Candle[] = oneMinData.map((c) => ({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            quoteVolume: c.quoteVolume,
          }));

          aggregator.initializeCandles(symbol, formatted1m);
          console.log(
            `[History] Initialized aggregator with ${formatted1m.length} 1m candles for ${symbol}`
          );
        }
      }

      console.log(`[History] Returning ${formattedCandles.length} ${interval} candles for ${symbol}`);
      return formattedCandles;
    } catch (error) {
      console.error(
        `[History] Failed to fetch historical candles for ${symbol} ${interval}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Prefetch 1-minute candles for a symbol to warm up the aggregator
   * Useful when starting the server
   */
  async warmupAggregator(symbol: string): Promise<void> {
    try {
      console.log(`[History] Warming up aggregator for ${symbol}`);

      const candles = await getCandlesticks(symbol, '1m', 1440); // Last 24 hours
      const formattedCandles: Candle[] = candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        quoteVolume: c.quoteVolume,
      }));

      const aggregator = getCandleAggregator();
      aggregator.initializeCandles(symbol, formattedCandles);

      console.log(
        `[History] Aggregator warmed up with ${formattedCandles.length} 1m candles for ${symbol}`
      );
    } catch (error) {
      console.error(`[History] Failed to warm up aggregator for ${symbol}:`, error);
      // Don't throw - warmup is optional
    }
  }
}

// Singleton instance
let historyService: HistoryService | null = null;

export const getHistoryService = (): HistoryService => {
  if (!historyService) {
    historyService = new HistoryService();
  }
  return historyService;
};
