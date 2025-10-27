// backend/src/api/handlers/candles.ts
import {
  ExtendedWebSocket,
  ClientMessage,
  SubscribeMessage,
  UnsubscribeMessage,
  ErrorMessage,
  InitialDataMessage,
  PongMessage,
  VALID_INTERVALS,
} from '../../types/websocket.js';
import { getRoomBroadcaster } from '../../services/broadcaster.js';
import { getHistoryService } from '../../services/history.js';

/**
 * Handle incoming WebSocket messages from clients
 */
export const handleClientMessage = async (
  client: ExtendedWebSocket,
  data: string
): Promise<void> => {
  try {
    const message: ClientMessage = JSON.parse(data);

    switch (message.type) {
      case 'subscribe':
        await handleSubscribe(client, message);
        break;

      case 'unsubscribe':
        await handleUnsubscribe(client, message);
        break;

      case 'ping':
        handlePing(client);
        break;

      default:
        sendError(client, `Unknown message type: ${(message as any).type}`);
    }
  } catch (error) {
    console.error(`[WebSocket] Error handling message from client ${client.id}:`, error);
    sendError(client, 'Invalid message format');
  }
};

/**
 * Handle subscribe message
 */
const handleSubscribe = async (
  client: ExtendedWebSocket,
  message: SubscribeMessage
): Promise<void> => {
  const { symbol, interval, initialBars = 100 } = message;

  // Validate interval
  if (!VALID_INTERVALS.includes(interval as any)) {
    sendError(client, `Invalid interval: ${interval}. Valid: ${VALID_INTERVALS.join(', ')}`);
    return;
  }

  // Validate symbol (for now, only BTC/USDT)
  if (symbol !== 'BTC/USDT') {
    sendError(client, `Invalid symbol: ${symbol}. Only BTC/USDT is supported.`);
    return;
  }

  console.log(
    `[WebSocket] Client ${client.id} subscribing to ${symbol} ${interval} (initial: ${initialBars})`
  );

  try {
    // Add client to room
    const broadcaster = getRoomBroadcaster();
    broadcaster.addClientToRoom(client, { symbol, interval });

    // Fetch and send initial historical data
    const historyService = getHistoryService();
    const candles = await historyService.getHistoricalCandles(symbol, interval, initialBars);

    const response: InitialDataMessage = {
      type: 'initial',
      symbol,
      interval,
      bars: candles,
    };

    client.send(JSON.stringify(response));

    console.log(
      `[WebSocket] Sent ${candles.length} initial ${interval} candles to client ${client.id}`
    );
  } catch (error) {
    console.error(`[WebSocket] Error subscribing client ${client.id}:`, error);
    sendError(client, 'Failed to subscribe to candles');
  }
};

/**
 * Handle unsubscribe message
 */
const handleUnsubscribe = async (
  client: ExtendedWebSocket,
  message: UnsubscribeMessage
): Promise<void> => {
  const { symbol, interval } = message;

  console.log(`[WebSocket] Client ${client.id} unsubscribing from ${symbol} ${interval}`);

  try {
    const broadcaster = getRoomBroadcaster();
    broadcaster.removeClientFromRoom(client, { symbol, interval });
  } catch (error) {
    console.error(`[WebSocket] Error unsubscribing client ${client.id}:`, error);
    sendError(client, 'Failed to unsubscribe from candles');
  }
};

/**
 * Handle ping message
 */
const handlePing = (client: ExtendedWebSocket): void => {
  const response: PongMessage = {
    type: 'pong',
  };
  client.send(JSON.stringify(response));
};

/**
 * Send error message to client
 */
const sendError = (client: ExtendedWebSocket, message: string): void => {
  const error: ErrorMessage = {
    type: 'error',
    message,
  };

  try {
    client.send(JSON.stringify(error));
  } catch (err) {
    console.error(`[WebSocket] Failed to send error to client ${client.id}:`, err);
  }
};
