// backend/src/websocket/server.ts
import { Server as HTTPServer } from 'http';
import WebSocket, { WebSocketServer as WSServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from 'redis';
import { ExtendedWebSocket, Candle } from './types.js';
import { handleClientMessage } from './handlers/candles.js';
import { getRoomBroadcaster } from './broadcaster.js';
import { getCandleAggregator } from './aggregator.js';
import { getHistoryService } from './history.js';

export class WebSocketServer {
  private wss: WSServer | null = null;
  private redisSubscriber: ReturnType<typeof createClient> | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

  /**
   * Initialize the WebSocket server
   */
  async initialize(server: HTTPServer): Promise<void> {
    console.log('[WebSocket] Initializing WebSocket server...');

    // Create WebSocket server
    this.wss = new WSServer({ server });

    // Set up Redis subscriber for candle updates
    await this.setupRedisSubscriber();

    // Set up WebSocket connection handler
    this.setupConnectionHandler();

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
   * Set up WebSocket connection handler
   */
  private setupConnectionHandler(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket) => {
      const client = ws as ExtendedWebSocket;
      client.id = uuidv4();
      client.isAlive = true;
      client.subscriptions = new Set();

      console.log(`[WebSocket] Client ${client.id} connected`);

      // Handle pong responses for heartbeat
      client.on('pong', () => {
        client.isAlive = true;
      });

      // Handle incoming messages
      client.on('message', async (data: Buffer) => {
        try {
          await handleClientMessage(client, data.toString());
        } catch (error) {
          console.error(`[WebSocket] Error handling message from ${client.id}:`, error);
        }
      });

      // Handle client disconnect
      client.on('close', () => {
        console.log(`[WebSocket] Client ${client.id} disconnected`);

        // Remove from all rooms
        const broadcaster = getRoomBroadcaster();
        broadcaster.removeClientFromAllRooms(client);
      });

      // Handle errors
      client.on('error', (error) => {
        console.error(`[WebSocket] Client ${client.id} error:`, error);
      });
    });
  }

  /**
   * Start heartbeat to detect dead connections
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;

      this.wss.clients.forEach((ws) => {
        const client = ws as ExtendedWebSocket;

        if (!client.isAlive) {
          console.log(`[WebSocket] Terminating dead connection: ${client.id}`);
          const broadcaster = getRoomBroadcaster();
          broadcaster.removeClientFromAllRooms(client);
          return client.terminate();
        }

        client.isAlive = false;
        client.ping();
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Get server statistics
   */
  getStats() {
    const broadcaster = getRoomBroadcaster();
    const aggregator = getCandleAggregator();

    return {
      connections: this.wss?.clients.size || 0,
      broadcaster: broadcaster.getStats(),
      aggregator: {
        oneMinuteCandlesCount: aggregator.getOneMinuteCandles('BTC/USDT').length,
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

    // Close all WebSocket connections
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.close();
      });
      this.wss.close();
    }

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
