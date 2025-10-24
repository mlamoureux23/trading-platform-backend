// backend/src/websocket/types.ts
import WebSocket from 'ws';

export interface Candle {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
}

export interface SubscribeMessage {
  type: 'subscribe';
  symbol: string;
  interval: string;
  initialBars?: number;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  symbol: string;
  interval: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

export interface InitialDataMessage {
  type: 'initial';
  symbol: string;
  interval: string;
  bars: Candle[];
}

export interface UpdateMessage {
  type: 'update';
  symbol: string;
  interval: string;
  bar: Candle;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export type ServerMessage = InitialDataMessage | UpdateMessage | ErrorMessage | PongMessage;

export interface ExtendedWebSocket extends WebSocket {
  id: string;
  isAlive: boolean;
  subscriptions: Set<string>;
}

export interface Subscription {
  symbol: string;
  interval: string;
}

export interface Room {
  key: string;
  subscription: Subscription;
  clients: Set<ExtendedWebSocket>;
  currentCandle: Candle | null;
  lastBroadcast: number;
}

export const VALID_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'] as const;
export type ValidInterval = typeof VALID_INTERVALS[number];

export const INTERVAL_TO_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
};
