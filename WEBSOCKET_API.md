# WebSocket API Documentation

## Overview

The Trading Platform WebSocket API provides real-time candlestick (OHLCV) data for cryptocurrency pairs. The system supports multiple timeframes and efficiently broadcasts updates to many concurrent clients.

## Connection

Connect to the WebSocket server at:
```
ws://localhost:7000
```

In production:
```
wss://your-domain.com
```

## Architecture

### Data Flow
```
Bitget Exchange → Services (Ingestion) → Redis Pub/Sub → Backend WebSocket → Clients
                         ↓
                    TimescaleDB (Storage)
```

### Key Features
- **Real-time updates**: Receive candle updates every ~1 second
- **Multiple timeframes**: 1m, 5m, 15m, 1h, 4h, 1D, 1W
- **Efficient aggregation**: Higher timeframes built from 1-minute candles in-memory
- **Room-based broadcasting**: Clients grouped by (symbol, interval) for efficient broadcasting
- **Automatic reconnection**: Built-in heartbeat to detect dead connections
- **Historical data**: Fetch initial candles on subscription

## Message Protocol

All messages are JSON-encoded strings.

### Client → Server Messages

#### 1. Subscribe to Candles
```json
{
  "type": "subscribe",
  "symbol": "BTC/USDT",
  "interval": "5m",
  "initialBars": 100
}
```

**Parameters:**
- `type`: Must be `"subscribe"`
- `symbol`: Trading pair (currently only `"BTC/USDT"` supported)
- `interval`: Timeframe - one of: `"1m"`, `"5m"`, `"15m"`, `"1h"`, `"4h"`, `"1D"`, `"1W"`
- `initialBars`: (Optional) Number of historical candles to fetch (default: 100)

**Response:**
Server will send an `initial` message with historical data, followed by `update` messages.

#### 2. Unsubscribe from Candles
```json
{
  "type": "unsubscribe",
  "symbol": "BTC/USDT",
  "interval": "5m"
}
```

**Parameters:**
- `type`: Must be `"unsubscribe"`
- `symbol`: Trading pair
- `interval`: Timeframe

#### 3. Ping
```json
{
  "type": "ping"
}
```

Server will respond with a `pong` message.

### Server → Client Messages

#### 1. Initial Data
Sent immediately after subscribing, contains historical candles.

```json
{
  "type": "initial",
  "symbol": "BTC/USDT",
  "interval": "5m",
  "bars": [
    {
      "time": "2024-10-24T10:00:00.000Z",
      "open": 67234.50,
      "high": 67340.00,
      "low": 67200.00,
      "close": 67310.25,
      "volume": 145.23,
      "quoteVolume": 9772345.67
    },
    // ... more candles
  ]
}
```

#### 2. Update
Sent every ~1 second when candle data changes.

```json
{
  "type": "update",
  "symbol": "BTC/USDT",
  "interval": "5m",
  "bar": {
    "time": "2024-10-24T10:00:00.000Z",
    "open": 67234.50,
    "high": 67340.00,
    "low": 67200.00,
    "close": 67310.25,
    "volume": 145.23,
    "quoteVolume": 9772345.67
  }
}
```

**Note:** The same candle is updated multiple times as new 1-minute data arrives. When a new interval starts, you'll receive a new candle with a different `time`.

#### 3. Error
```json
{
  "type": "error",
  "message": "Invalid interval: 10m. Valid: 1m, 5m, 15m, 1h, 4h, 1D, 1W"
}
```

#### 4. Pong
Response to ping.

```json
{
  "type": "pong"
}
```

## Candle Object

```typescript
interface Candle {
  time: Date;           // ISO 8601 timestamp of candle start
  open: number;         // Opening price
  high: number;         // Highest price
  low: number;          // Lowest price
  close: number;        // Closing price (current price if in-progress)
  volume: number;       // Base currency volume
  quoteVolume?: number; // Quote currency volume (optional)
}
```

## Usage Examples

### JavaScript/TypeScript

```javascript
const ws = new WebSocket('ws://localhost:7000');

ws.onopen = () => {
  console.log('Connected to WebSocket');

  // Subscribe to BTC/USDT 5-minute candles
  ws.send(JSON.stringify({
    type: 'subscribe',
    symbol: 'BTC/USDT',
    interval: '5m',
    initialBars: 100
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case 'initial':
      console.log(`Received ${message.bars.length} initial candles`);
      // Initialize your chart with message.bars
      break;

    case 'update':
      console.log('Candle update:', message.bar);
      // Update your chart with the new/updated candle
      break;

    case 'error':
      console.error('Error:', message.message);
      break;

    case 'pong':
      console.log('Pong received');
      break;
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected from WebSocket');
};
```

### React Hook Example

```typescript
import { useEffect, useRef, useState } from 'react';

interface UseWebSocketCandlesOptions {
  symbol: string;
  interval: string;
  initialBars?: number;
}

export const useWebSocketCandles = ({
  symbol,
  interval,
  initialBars = 100
}: UseWebSocketCandlesOptions) => {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:7000');
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      ws.send(JSON.stringify({
        type: 'subscribe',
        symbol,
        interval,
        initialBars
      }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'initial') {
        setCandles(message.bars);
      } else if (message.type === 'update') {
        setCandles(prev => {
          const last = prev[prev.length - 1];

          // Check if update is for current candle or new candle
          if (last && new Date(last.time).getTime() === new Date(message.bar.time).getTime()) {
            // Update current candle
            return [...prev.slice(0, -1), message.bar];
          } else {
            // New candle
            return [...prev, message.bar];
          }
        });
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [symbol, interval, initialBars]);

  return { candles, isConnected };
};
```

## Monitoring

### Health Check
```bash
curl http://localhost:7000/health
```

### WebSocket Statistics
```bash
curl http://localhost:7000/health/ws-stats
```

**Response:**
```json
{
  "connections": 5,
  "broadcaster": {
    "totalRooms": 3,
    "totalClients": 5,
    "rooms": [
      {
        "key": "BTC/USDT:1m",
        "clientCount": 2,
        "hasCandle": true,
        "lastBroadcast": 1698150123456
      },
      {
        "key": "BTC/USDT:5m",
        "clientCount": 2,
        "hasCandle": true,
        "lastBroadcast": 1698150123456
      },
      {
        "key": "BTC/USDT:1h",
        "clientCount": 1,
        "hasCandle": true,
        "lastBroadcast": 1698150123456
      }
    ]
  },
  "aggregator": {
    "oneMinuteCandlesCount": 1440
  }
}
```

## Rate Limiting

The WebSocket server uses the same rate limiting as the REST API:
- 100 requests per 15 minutes per IP
- Applied to the `/api/` routes, not WebSocket connections

WebSocket connections themselves are not rate-limited, but consider implementing client-side reconnection backoff.

## Error Handling

### Common Errors

1. **Invalid interval**
   ```json
   {"type": "error", "message": "Invalid interval: 10m. Valid: 1m, 5m, 15m, 1h, 4h, 1D, 1W"}
   ```

2. **Invalid symbol**
   ```json
   {"type": "error", "message": "Invalid symbol: ETH/USDT. Only BTC/USDT is supported."}
   ```

3. **Invalid message format**
   ```json
   {"type": "error", "message": "Invalid message format"}
   ```

### Best Practices

1. **Implement reconnection logic** with exponential backoff
2. **Handle disconnections gracefully** - save state and restore on reconnect
3. **Validate messages** on both client and server
4. **Use heartbeat/ping** to detect connection issues
5. **Subscribe to one interval per connection** for simplicity

## Scalability

The system is designed to handle many concurrent connections:

- **Room-based broadcasting**: Clients subscribed to same (symbol, interval) are grouped
- **Redis Pub/Sub**: Allows horizontal scaling with multiple backend instances
- **In-memory aggregation**: No database queries for real-time updates
- **Connection pooling**: Efficient database connection management
- **Throttled updates**: Maximum 1 update per second per room

For high-scale deployments:
1. Run multiple backend instances behind a load balancer (with sticky sessions)
2. Use Redis Cluster for pub/sub
3. Consider separating WebSocket servers from REST API servers
4. Implement connection limits per instance

## Troubleshooting

### No updates received
1. Check if services container is running and ingesting data
2. Verify Redis connection in both services and backend
3. Check WebSocket stats endpoint for active subscriptions
4. Enable verbose logging in services

### High latency
1. Check network connection
2. Monitor Redis pub/sub lag
3. Check backend CPU/memory usage
4. Verify TimescaleDB query performance

### Connection drops
1. Check network stability
2. Implement proper reconnection logic
3. Monitor server logs for errors
4. Verify heartbeat is working
