// backend/src/websocket.ts
import { Server as HTTPServer } from 'http';
import { createClient } from 'redis';
import { ExtendedWebSocket, Candle } from './types/websocket.js';
import { getWebSocketHandlers } from './api/handlers/index.js';
import { getRoomBroadcaster } from './services/broadcaster.js';
import { getCandleAggregator } from './services/aggregator.js';
import { getHistoryService } from './services/history.js';

/**
 * WebSocket Server Manager
 * Handles WebSocket initialization, Redis subscriptions, and heartbeat monitoring
 */
export class WebSocketServer {
  private redisSubscriber: ReturnType<typeof createClient> | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

  /**
   * Initialize the WebSocket server
   */
  async initialize(server: HTTPServer): Promise<void> {
    console.log('[WebSocket] Initializing WebSocket server...');

    // Initialize WebSocket handlers
    const handlers = getWebSocketHandlers();
    await handlers.initialize(server);

    // Set up Redis subscriber for candle updates
    await this.setupRedisSubscriber();

    // Start heartbeat to detect dead connections
    this.startHeartbeat();

    // Warm up aggregator with BTC/USDT data
    const historyService = getHistoryService();
    await historyService.warmupAggregator('BTC/USDT');

    console.log('[WebSocket] WebSocket server initialized');
  }

  /**
   * Set up Redis subscriber to listen for candle updates
   */
  private async setupRedisSubscriber(): Promise<void> {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '7379');

    console.log(`[WebSocket] Connecting to Redis at ${redisHost}:${redisPort}...`);

    this.redisSubscriber = createClient({
      socket: {
        host: redisHost,
        port: redisPort,
      },
    });

    this.redisSubscriber.on('error', (err) => {
      console.error('[WebSocket] Redis Subscriber Error:', err);
    });

    await this.redisSubscriber.connect();
    console.log('[WebSocket] Redis subscriber connected');

    // Subscribe to BTC/USDT 1-minute candles
    await this.redisSubscriber.subscribe('candles:BTC/USDT:1m', (message) => {
      this.handleCandleUpdate(message);
    });

    console.log('[WebSocket] Subscribed to candles:BTC/USDT:1m');
  }

  /**
   * Handle incoming candle updates from Redis
   */
  private handleCandleUpdate(message: string): void {
    try {
      const candle: Candle = JSON.parse(message);

      // Update aggregator with new 1m candle
      const aggregator = getCandleAggregator();
      aggregator.processOneMinuteCandle('BTC/USDT', candle);

      // Update broadcaster with new data
      const broadcaster = getRoomBroadcaster();
      broadcaster.updateRoomCandle('BTC/USDT');
    } catch (error) {
      console.error('[WebSocket] Error handling candle update:', error);
    }
  }

  /**
   * Start heartbeat to detect dead connections
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const handlers = getWebSocketHandlers();
      const servers = handlers.getServers();

      // Heartbeat for candles clients
      if (servers.candles) {
        servers.candles.clients.forEach((ws) => {
          const client = ws as ExtendedWebSocket;

          if (!client.isAlive) {
            console.log(`[WebSocket] Terminating dead candles connection: ${client.id}`);
            const broadcaster = getRoomBroadcaster();
            broadcaster.removeClientFromAllRooms(client);
            return client.terminate();
          }

          client.isAlive = false;
          client.ping();
        });
      }

      // Heartbeat for whale alert clients
      if (servers.whales) {
        servers.whales.clients.forEach((ws) => {
          const client = ws as any;

          if (client.isAlive === false) {
            console.log(`[WebSocket] Terminating dead whale alerts connection: ${client.id}`);
            return client.terminate();
          }

          client.isAlive = false;
          client.ping();
        });
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Get server statistics
   */
  getStats() {
    const handlers = getWebSocketHandlers();
    const servers = handlers.getServers();
    const broadcaster = getRoomBroadcaster();
    const aggregator = getCandleAggregator();

    return {
      candles: {
        connections: servers.candles?.clients.size || 0,
        broadcaster: broadcaster.getStats(),
        aggregator: {
          oneMinuteCandlesCount: aggregator.getOneMinuteCandles('BTC/USDT').length,
        },
      },
      whales: {
        connections: servers.whales?.clients.size || 0,
      },
    };
  }

  /**
   * Shutdown the WebSocket server
   */
  async shutdown(): Promise<void> {
    console.log('[WebSocket] Shutting down WebSocket server...');

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Stop broadcaster
    const broadcaster = getRoomBroadcaster();
    broadcaster.stop();

    // Shutdown handlers
    const handlers = getWebSocketHandlers();
    await handlers.shutdown();

    // Close Redis subscriber
    if (this.redisSubscriber) {
      await this.redisSubscriber.quit();
    }

    console.log('[WebSocket] WebSocket server shut down');
  }
}

// Singleton instance
let wsServer: WebSocketServer | null = null;

export const getWebSocketServer = (): WebSocketServer => {
  if (!wsServer) {
    wsServer = new WebSocketServer();
  }
  return wsServer;
};
