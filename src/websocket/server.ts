// backend/src/websocket/server.ts
import { Server as HTTPServer } from 'http';
import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer as WSServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from 'redis';
import { ExtendedWebSocket, Candle } from './types.js';
import { handleClientMessage } from './handlers/candles.js';
import { getRoomBroadcaster } from './broadcaster.js';
import { getCandleAggregator } from './aggregator.js';
import { getHistoryService } from './history.js';
import { getWhaleAlertsHandler } from './handlers/whales.js';

export class WebSocketServer {
  private wss: WSServer | null = null;
  private whalesWss: WSServer | null = null;
  private redisSubscriber: ReturnType<typeof createClient> | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

  /**
   * Initialize the WebSocket server
   */
  async initialize(server: HTTPServer): Promise<void> {
    console.log('[WebSocket] Initializing WebSocket server...');

    // Create WebSocket server for candles (default path)
    this.wss = new WSServer({ noServer: true });

    // Create WebSocket server for whale alerts
    this.whalesWss = new WSServer({ noServer: true });

    // Set up path-based routing
    this.setupPathRouting(server);

    // Set up Redis subscriber for candle updates
    await this.setupRedisSubscriber();

    // Set up WebSocket connection handler for candles
    this.setupConnectionHandler();

    // Initialize whale alerts handler
    const whaleHandler = getWhaleAlertsHandler();
    await whaleHandler.initialize();

    // Set up connection handler for whale alerts
    this.setupWhaleConnectionHandler();

    // Start heartbeat to detect dead connections
    this.startHeartbeat();

    // Warm up aggregator with BTC/USDT data
    const historyService = getHistoryService();
    await historyService.warmupAggregator('BTC/USDT');

    console.log('[WebSocket] WebSocket server initialized');
    console.log('[WebSocket] Candles endpoint: ws://localhost:PORT/');
    console.log('[WebSocket] Whale alerts endpoint: ws://localhost:PORT/whales');
  }

  /**
   * Set up path-based routing for WebSocket connections
   */
  private setupPathRouting(server: HTTPServer): void {
    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      const pathname = request.url || '/';

      if (pathname === '/whales') {
        // Route to whale alerts WebSocket
        this.whalesWss?.handleUpgrade(request, socket, head, (ws) => {
          this.whalesWss?.emit('connection', ws, request);
        });
      } else {
        // Route to candles WebSocket (default)
        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.wss?.emit('connection', ws, request);
        });
      }
    });
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
   * Set up WebSocket connection handler for candles
   */
  private setupConnectionHandler(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket) => {
      const client = ws as ExtendedWebSocket;
      client.id = uuidv4();
      client.isAlive = true;
      client.subscriptions = new Set();

      console.log(`[WebSocket] Client ${client.id} connected to candles`);

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
   * Set up WebSocket connection handler for whale alerts
   */
  private setupWhaleConnectionHandler(): void {
    if (!this.whalesWss) return;

    this.whalesWss.on('connection', async (ws: WebSocket) => {
      const clientId = uuidv4();
      const whaleHandler = getWhaleAlertsHandler();
      await whaleHandler.handleConnection(ws, clientId);
    });
  }

  /**
   * Start heartbeat to detect dead connections
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      // Heartbeat for candles clients
      if (this.wss) {
        this.wss.clients.forEach((ws) => {
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
      if (this.whalesWss) {
        this.whalesWss.clients.forEach((ws) => {
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
    const broadcaster = getRoomBroadcaster();
    const aggregator = getCandleAggregator();
    const whaleHandler = getWhaleAlertsHandler();

    return {
      candles: {
        connections: this.wss?.clients.size || 0,
        broadcaster: broadcaster.getStats(),
        aggregator: {
          oneMinuteCandlesCount: aggregator.getOneMinuteCandles('BTC/USDT').length,
        },
      },
      whales: {
        connections: this.whalesWss?.clients.size || 0,
        ...whaleHandler.getStats(),
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

    // Shutdown whale alerts handler
    const whaleHandler = getWhaleAlertsHandler();
    await whaleHandler.shutdown();

    // Close all candles WebSocket connections
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.close();
      });
      this.wss.close();
    }

    // Close all whale alerts WebSocket connections
    if (this.whalesWss) {
      this.whalesWss.clients.forEach((client) => {
        client.close();
      });
      this.whalesWss.close();
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
