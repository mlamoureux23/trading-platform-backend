import express, { Application } from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { connectDB, closeDB } from './db/connection.js';
import { connectRedis, closeRedis } from './db/redis.js';
import { connectTimescaleDB, closeTimescaleDB } from './db/timescale.js';
import { getWebSocketServer } from './websocket.js';
import healthRouter from './api/routes/health.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

// Load environment variables
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:7173',
  credentials: true
}));
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/', limiter);

// Routes
app.get('/', (_req, res) => {
  res.json({
    name: 'Trading Platform API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      api: '/api'
    }
  });
});

app.use('/health', healthRouter);

// API routes will go here
// app.use('/api/trades', tradeRouter);
// app.use('/api/users', userRouter);

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
async function startServer(): Promise<void> {
  try {
    // Connect to PostgreSQL
    await connectDB();
    console.log('✓ Connected to PostgreSQL');

    // Connect to Redis
    await connectRedis();
    console.log('✓ Connected to Redis');

    // Connect to TimescaleDB
    await connectTimescaleDB();
    console.log('✓ Connected to TimescaleDB');

    // Create HTTP server
    const httpServer = createServer(app);

    // Initialize WebSocket server
    const wsServer = getWebSocketServer();
    await wsServer.initialize(httpServer);
    console.log('✓ WebSocket server initialized');

    // Start HTTP server
    httpServer.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✓ WebSocket available at ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  const wsServer = getWebSocketServer();
  await wsServer.shutdown();
  await closeTimescaleDB();
  await closeDB();
  await closeRedis();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  const wsServer = getWebSocketServer();
  await wsServer.shutdown();
  await closeTimescaleDB();
  await closeDB();
  await closeRedis();
  process.exit(0);
});

startServer();

export default app;
