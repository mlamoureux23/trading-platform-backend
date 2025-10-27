// backend/src/api/handlers/index.ts
import { Server as HTTPServer } from 'http';
import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer as WSServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { ExtendedWebSocket } from '../../types/websocket.js';
import { handleClientMessage } from './candles.js';
import { getWhaleAlertsHandler } from './whales.js';
import { getRoomBroadcaster } from '../../services/broadcaster.js';

/**
 * WebSocket Handlers Manager
 * Central place to manage all WebSocket routes and their handlers
 */
export class WebSocketHandlers {
  private candlesWss: WSServer | null = null;
  private whalesWss: WSServer | null = null;

  /**
   * Initialize all WebSocket handlers
   */
  async initialize(server: HTTPServer): Promise<void> {
    console.log('[WS Handlers] Initializing WebSocket handlers...');

    // Create WebSocket servers
    this.candlesWss = new WSServer({ noServer: true });
    this.whalesWss = new WSServer({ noServer: true });

    // Set up path-based routing
    this.setupPathRouting(server);

    // Initialize candles handler
    this.setupCandlesHandler();

    // Initialize whale alerts handler
    const whaleHandler = getWhaleAlertsHandler();
    await whaleHandler.initialize();
    this.setupWhalesHandler();

    console.log('[WS Handlers] WebSocket handlers initialized');
    console.log('[WS Handlers] Routes:');
    console.log('[WS Handlers]   - ws://localhost:PORT/        -> Candles');
    console.log('[WS Handlers]   - ws://localhost:PORT/whales  -> Whale Alerts');
  }

  /**
   * Set up path-based routing for WebSocket connections
   */
  private setupPathRouting(server: HTTPServer): void {
    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      const pathname = request.url || '/';

      // Route based on path
      if (pathname === '/whales') {
        this.whalesWss?.handleUpgrade(request, socket, head, (ws) => {
          this.whalesWss?.emit('connection', ws, request);
        });
      } else {
        // Default route to candles
        this.candlesWss?.handleUpgrade(request, socket, head, (ws) => {
          this.candlesWss?.emit('connection', ws, request);
        });
      }
    });
  }

  /**
   * Set up connection handler for candles
   */
  private setupCandlesHandler(): void {
    if (!this.candlesWss) return;

    this.candlesWss.on('connection', (ws: WebSocket) => {
      const client = ws as ExtendedWebSocket;
      client.id = uuidv4();
      client.isAlive = true;
      client.subscriptions = new Set();

      console.log(`[Candles] Client ${client.id} connected`);

      // Handle pong responses for heartbeat
      client.on('pong', () => {
        client.isAlive = true;
      });

      // Handle incoming messages
      client.on('message', async (data: Buffer) => {
        try {
          await handleClientMessage(client, data.toString());
        } catch (error) {
          console.error(`[Candles] Error handling message from ${client.id}:`, error);
        }
      });

      // Handle client disconnect
      client.on('close', () => {
        console.log(`[Candles] Client ${client.id} disconnected`);

        // Remove from all rooms
        const broadcaster = getRoomBroadcaster();
        broadcaster.removeClientFromAllRooms(client);
      });

      // Handle errors
      client.on('error', (error) => {
        console.error(`[Candles] Client ${client.id} error:`, error);
      });
    });
  }

  /**
   * Set up connection handler for whale alerts
   */
  private setupWhalesHandler(): void {
    if (!this.whalesWss) return;

    this.whalesWss.on('connection', async (ws: WebSocket) => {
      const clientId = uuidv4();
      const whaleHandler = getWhaleAlertsHandler();
      await whaleHandler.handleConnection(ws, clientId);
    });
  }

  /**
   * Get WebSocket servers for heartbeat monitoring
   */
  getServers() {
    return {
      candles: this.candlesWss,
      whales: this.whalesWss,
    };
  }

  /**
   * Shutdown all handlers
   */
  async shutdown(): Promise<void> {
    console.log('[WS Handlers] Shutting down WebSocket handlers...');

    // Close candles connections
    if (this.candlesWss) {
      this.candlesWss.clients.forEach((client) => {
        client.close();
      });
      this.candlesWss.close();
    }

    // Close whale alerts connections
    if (this.whalesWss) {
      this.whalesWss.clients.forEach((client) => {
        client.close();
      });
      this.whalesWss.close();
    }

    // Shutdown whale handler
    const whaleHandler = getWhaleAlertsHandler();
    await whaleHandler.shutdown();

    console.log('[WS Handlers] WebSocket handlers shut down');
  }
}

// Singleton instance
let wsHandlers: WebSocketHandlers | null = null;

export const getWebSocketHandlers = (): WebSocketHandlers => {
  if (!wsHandlers) {
    wsHandlers = new WebSocketHandlers();
  }
  return wsHandlers;
};
