// backend/src/services/broadcaster.ts
import { ExtendedWebSocket, Room, Subscription, UpdateMessage } from '../types/websocket.js';
import { getCandleAggregator } from './aggregator.js';

/**
 * RoomBroadcaster manages subscription rooms and broadcasts updates to clients
 * Groups clients by (symbol, interval) and broadcasts at most once per second
 */
export class RoomBroadcaster {
  private rooms: Map<string, Room> = new Map();
  private broadcastInterval: NodeJS.Timeout | null = null;
  private readonly BROADCAST_INTERVAL_MS = 1000; // 1 second

  constructor() {
    this.startBroadcastLoop();
  }

  /**
   * Add a client to a room (creates room if it doesn't exist)
   */
  addClientToRoom(client: ExtendedWebSocket, subscription: Subscription): void {
    const roomKey = this.getRoomKey(subscription);

    if (!this.rooms.has(roomKey)) {
      this.rooms.set(roomKey, {
        key: roomKey,
        subscription,
        clients: new Set(),
        currentCandle: null,
        lastBroadcast: 0,
      });
    }

    const room = this.rooms.get(roomKey)!;
    room.clients.add(client);

    // Add to client's subscriptions
    client.subscriptions.add(roomKey);

    console.log(
      `[WebSocket] Client ${client.id} joined room ${roomKey} (${room.clients.size} clients)`
    );
  }

  /**
   * Remove a client from a room
   */
  removeClientFromRoom(client: ExtendedWebSocket, subscription: Subscription): void {
    const roomKey = this.getRoomKey(subscription);
    const room = this.rooms.get(roomKey);

    if (room) {
      room.clients.delete(client);
      client.subscriptions.delete(roomKey);

      console.log(
        `[WebSocket] Client ${client.id} left room ${roomKey} (${room.clients.size} clients)`
      );

      // Remove room if empty
      if (room.clients.size === 0) {
        this.rooms.delete(roomKey);
        console.log(`[WebSocket] Room ${roomKey} removed (no clients)`);
      }
    }
  }

  /**
   * Remove a client from all rooms
   */
  removeClientFromAllRooms(client: ExtendedWebSocket): void {
    for (const roomKey of client.subscriptions) {
      const room = this.rooms.get(roomKey);
      if (room) {
        room.clients.delete(client);

        // Remove room if empty
        if (room.clients.size === 0) {
          this.rooms.delete(roomKey);
          console.log(`[WebSocket] Room ${roomKey} removed (no clients)`);
        }
      }
    }
    client.subscriptions.clear();
  }

  /**
   * Update the current candle for a room
   * Called when a new 1-minute candle arrives from Redis
   */
  updateRoomCandle(symbol: string): void {
    const aggregator = getCandleAggregator();

    // Update all rooms for this symbol
    for (const room of this.rooms.values()) {
      if (room.subscription.symbol === symbol) {
        // Get the aggregated candle for this room's interval
        const candle = aggregator.getAggregatedCandle(symbol, room.subscription.interval);
        if (candle) {
          room.currentCandle = candle;
        }
      }
    }
  }

  /**
   * Broadcast loop - runs every second
   * Sends updates to rooms that have new data
   */
  private startBroadcastLoop(): void {
    this.broadcastInterval = setInterval(() => {
      const now = Date.now();

      for (const room of this.rooms.values()) {
        // Skip if no clients
        if (room.clients.size === 0) {
          continue;
        }

        // Skip if no current candle
        if (!room.currentCandle) {
          continue;
        }

        // Check if we should broadcast (at most once per second)
        if (now - room.lastBroadcast < this.BROADCAST_INTERVAL_MS) {
          continue;
        }

        // Broadcast to all clients in the room
        this.broadcastToRoom(room);
        room.lastBroadcast = now;
      }
    }, this.BROADCAST_INTERVAL_MS);
  }

  /**
   * Broadcast update to all clients in a room
   */
  private broadcastToRoom(room: Room): void {
    if (!room.currentCandle) {
      return;
    }

    const message: UpdateMessage = {
      type: 'update',
      symbol: room.subscription.symbol,
      interval: room.subscription.interval,
      bar: room.currentCandle,
    };

    const messageStr = JSON.stringify(message);
    let successCount = 0;
    let failCount = 0;

    // Send to all clients in the room
    for (const client of room.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
          client.send(messageStr);
          successCount++;
        } catch (error) {
          console.error(`[WebSocket] Failed to send to client ${client.id}:`, error);
          failCount++;
        }
      }
    }

    // Only log if there were issues
    if (failCount > 0 || successCount > 0) {
      console.log(
        `[WebSocket] Broadcast to room ${room.key}: ${successCount} clients (${failCount} failed)`
      );
    }
  }

  /**
   * Get room key from subscription
   */
  private getRoomKey(subscription: Subscription): string {
    return `${subscription.symbol}:${subscription.interval}`;
  }

  /**
   * Get room by key
   */
  getRoom(roomKey: string): Room | undefined {
    return this.rooms.get(roomKey);
  }

  /**
   * Get all rooms
   */
  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Stop the broadcast loop
   */
  stop(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  /**
   * Get stats for monitoring
   */
  getStats() {
    return {
      totalRooms: this.rooms.size,
      totalClients: Array.from(this.rooms.values()).reduce(
        (sum, room) => sum + room.clients.size,
        0
      ),
      rooms: Array.from(this.rooms.values()).map((room) => ({
        key: room.key,
        clientCount: room.clients.size,
        hasCandle: room.currentCandle !== null,
        lastBroadcast: room.lastBroadcast,
      })),
    };
  }
}

// Singleton instance
let broadcaster: RoomBroadcaster | null = null;

export const getRoomBroadcaster = (): RoomBroadcaster => {
  if (!broadcaster) {
    broadcaster = new RoomBroadcaster();
  }
  return broadcaster;
};
