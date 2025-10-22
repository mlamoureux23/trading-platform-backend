import express, { Request, Response } from 'express';
import { getDB } from '../db/connection.js';
import { getRedis } from '../db/redis.js';

const router = express.Router();

interface HealthResponse {
  uptime: number;
  timestamp: number;
  status: 'OK' | 'DEGRADED';
  services: {
    database: string;
    redis: string;
  };
}

router.get('/', async (_req: Request, res: Response) => {
  const health: HealthResponse = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    status: 'OK',
    services: {
      database: 'unknown',
      redis: 'unknown'
    }
  };

  try {
    // Check database connection
    const db = getDB();
    await db.query('SELECT 1');
    health.services.database = 'connected';
  } catch (error) {
    health.services.database = 'disconnected';
    health.status = 'DEGRADED';
  }

  try {
    // Check Redis connection
    const redis = getRedis();
    await redis.ping();
    health.services.redis = 'connected';
  } catch (error) {
    health.services.redis = 'disconnected';
    health.status = 'DEGRADED';
  }

  const statusCode = health.status === 'OK' ? 200 : 503;
  res.status(statusCode).json(health);
});

export default router;
