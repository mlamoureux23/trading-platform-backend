// backend/src/websocket/handlers/whales.ts
import WebSocket from 'ws';
import { createClient, RedisClientType } from 'redis';

interface WhaleWebSocket extends WebSocket {
  id: string;
  isAlive: boolean;
  subscriptions: Set<string>;
}

interface WhaleSubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

interface WhaleUnsubscribeMessage {
  type: 'unsubscribe';
  channels: string[];
}

interface WhalePingMessage {
  type: 'ping';
}

type WhaleClientMessage = WhaleSubscribeMessage | WhaleUnsubscribeMessage | WhalePingMessage;

interface WhaleAlertMessage {
  type: 'whale_alert';
  data: any;
}

interface SubscribedMessage {
  type: 'subscribed';
  channels: string[];
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

interface PongMessage {
  type: 'pong';
}

// Map frontend channels to Redis channels
const channelMap: Record<string, string> = {
  'bitcoin.all': 'whale:bitcoin:all',
  'bitcoin.large': 'whale:bitcoin:large',
  'bitcoin.watched': 'whale:bitcoin:watched',
};

/**
 * Whale Alerts WebSocket Handler
 */
export class WhaleAlertsHandler {
  private clients: Map<string, WhaleWebSocket> = new Map();
  private redisSubscriber: RedisClientType | null = null;
  private channelSubscriptions: Map<string, Set<string>> = new Map(); // channel -> Set<clientId>

  async initialize(): Promise<void> {
    console.log('[WhaleAlerts] Initializing whale alerts handler...');

    // Set up Redis subscriber
    await this.setupRedisSubscriber();

    console.log('[WhaleAlerts] Whale alerts handler initialized');
  }

  /**
   * Set up Redis subscriber
   */
  private async setupRedisSubscriber(): Promise<void> {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '7379');

    console.log(`[WhaleAlerts] Connecting to Redis at ${redisHost}:${redisPort}...`);

    this.redisSubscriber = createClient({
      socket: {
        host: redisHost,
        port: redisPort,
      },
    });

    this.redisSubscriber.on('error', (err) => {
      console.error('[WhaleAlerts] Redis Subscriber Error:', err);
    });

    await this.redisSubscriber.connect();
    console.log('[WhaleAlerts] Redis subscriber connected');
  }

  /**
   * Handle new client connection
   */
  async handleConnection(ws: WebSocket, clientId: string): Promise<void> {
    const client = ws as WhaleWebSocket;
    client.id = clientId;
    client.isAlive = true;
    client.subscriptions = new Set();

    this.clients.set(clientId, client);

    console.log(`[WhaleAlerts] Client ${clientId} connected to whale alerts`);

    // Handle pong for heartbeat
    client.on('pong', () => {
      client.isAlive = true;
    });

    // Handle messages
    client.on('message', async (data: Buffer) => {
      try {
        await this.handleMessage(client, data.toString());
      } catch (error) {
        console.error(`[WhaleAlerts] Error handling message from ${clientId}:`, error);
        this.sendError(client, 'Failed to process message');
      }
    });

    // Handle disconnect
    client.on('close', () => {
      console.log(`[WhaleAlerts] Client ${clientId} disconnected`);
      this.handleDisconnect(client);
    });

    // Handle errors
    client.on('error', (error) => {
      console.error(`[WhaleAlerts] Client ${clientId} error:`, error);
    });
  }

  /**
   * Handle incoming client messages
   */
  private async handleMessage(client: WhaleWebSocket, data: string): Promise<void> {
    try {
      const message: WhaleClientMessage = JSON.parse(data);

      switch (message.type) {
        case 'subscribe':
          await this.handleSubscribe(client, message);
          break;

        case 'unsubscribe':
          await this.handleUnsubscribe(client, message);
          break;

        case 'ping':
          this.handlePing(client);
          break;

        default:
          this.sendError(client, `Unknown message type: ${(message as any).type}`);
      }
    } catch (error) {
      console.error(`[WhaleAlerts] Error parsing message from ${client.id}:`, error);
      this.sendError(client, 'Invalid message format');
    }
  }

  /**
   * Handle subscribe request
   */
  private async handleSubscribe(
    client: WhaleWebSocket,
    message: WhaleSubscribeMessage
  ): Promise<void> {
    const { channels } = message;

    console.log(`[WhaleAlerts] Client ${client.id} subscribing to:`, channels);

    for (const channel of channels) {
      const redisChannel = channelMap[channel];

      if (!redisChannel) {
        this.sendError(client, `Invalid channel: ${channel}`);
        continue;
      }

      // Add to client subscriptions
      client.subscriptions.add(channel);

      // Track channel subscriptions
      if (!this.channelSubscriptions.has(redisChannel)) {
        this.channelSubscriptions.set(redisChannel, new Set());

        // Subscribe to Redis channel
        if (this.redisSubscriber) {
          await this.redisSubscriber.subscribe(redisChannel, (message) => {
            this.handleRedisMessage(redisChannel, message);
          });
          console.log(`[WhaleAlerts] Subscribed to Redis channel: ${redisChannel}`);
        }
      }

      this.channelSubscriptions.get(redisChannel)!.add(client.id);
    }

    // Send confirmation
    const response: SubscribedMessage = {
      type: 'subscribed',
      channels,
    };
    client.send(JSON.stringify(response));
  }

  /**
   * Handle unsubscribe request
   */
  private async handleUnsubscribe(
    client: WhaleWebSocket,
    message: WhaleUnsubscribeMessage
  ): Promise<void> {
    const { channels } = message;

    console.log(`[WhaleAlerts] Client ${client.id} unsubscribing from:`, channels);

    for (const channel of channels) {
      const redisChannel = channelMap[channel];

      if (!redisChannel) continue;

      // Remove from client subscriptions
      client.subscriptions.delete(channel);

      // Remove from channel subscriptions
      const subscribers = this.channelSubscriptions.get(redisChannel);
      if (subscribers) {
        subscribers.delete(client.id);

        // If no more subscribers, unsubscribe from Redis
        if (subscribers.size === 0 && this.redisSubscriber) {
          await this.redisSubscriber.unsubscribe(redisChannel);
          this.channelSubscriptions.delete(redisChannel);
          console.log(`[WhaleAlerts] Unsubscribed from Redis channel: ${redisChannel}`);
        }
      }
    }
  }

  /**
   * Handle ping
   */
  private handlePing(client: WhaleWebSocket): void {
    const response: PongMessage = {
      type: 'pong',
    };
    client.send(JSON.stringify(response));
  }

  /**
   * Handle Redis message (whale alert)
   */
  private handleRedisMessage(redisChannel: string, message: string): void {
    try {
      const whaleData = JSON.parse(message);

      // Get all clients subscribed to this channel
      const subscribers = this.channelSubscriptions.get(redisChannel);
      if (!subscribers) return;

      const response: WhaleAlertMessage = {
        type: 'whale_alert',
        data: whaleData,
      };

      const messageStr = JSON.stringify(response);

      // Broadcast to all subscribed clients
      subscribers.forEach((clientId) => {
        const client = this.clients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
          client.send(messageStr);
        }
      });

      console.log(
        `[WhaleAlerts] Broadcast whale alert to ${subscribers.size} clients on ${redisChannel}`
      );
    } catch (error) {
      console.error('[WhaleAlerts] Error handling Redis message:', error);
    }
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(client: WhaleWebSocket): void {
    // Remove from all channel subscriptions
    this.channelSubscriptions.forEach((subscribers, redisChannel) => {
      subscribers.delete(client.id);

      // Cleanup empty channels
      if (subscribers.size === 0 && this.redisSubscriber) {
        this.redisSubscriber.unsubscribe(redisChannel).catch((err) => {
          console.error(`[WhaleAlerts] Error unsubscribing from ${redisChannel}:`, err);
        });
        this.channelSubscriptions.delete(redisChannel);
      }
    });

    // Remove client
    this.clients.delete(client.id);
  }

  /**
   * Send error to client
   */
  private sendError(client: WhaleWebSocket, message: string): void {
    const error: ErrorMessage = {
      type: 'error',
      message,
    };

    try {
      client.send(JSON.stringify(error));
    } catch (err) {
      console.error(`[WhaleAlerts] Failed to send error to client ${client.id}:`, err);
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      clients: this.clients.size,
      channels: this.channelSubscriptions.size,
      subscriptions: Array.from(this.channelSubscriptions.entries()).map(([channel, subs]) => ({
        channel,
        subscribers: subs.size,
      })),
    };
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    console.log('[WhaleAlerts] Shutting down whale alerts handler...');

    // Close all client connections
    this.clients.forEach((client) => {
      client.close();
    });

    // Unsubscribe from all Redis channels
    if (this.redisSubscriber) {
      await this.redisSubscriber.quit();
    }

    this.clients.clear();
    this.channelSubscriptions.clear();

    console.log('[WhaleAlerts] Whale alerts handler shut down');
  }
}

// Singleton instance
let whaleAlertsHandler: WhaleAlertsHandler | null = null;

export const getWhaleAlertsHandler = (): WhaleAlertsHandler => {
  if (!whaleAlertsHandler) {
    whaleAlertsHandler = new WhaleAlertsHandler();
  }
  return whaleAlertsHandler;
};
