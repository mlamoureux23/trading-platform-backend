import dotenv from 'dotenv';
import { connectDB, query, closeDB } from './connection.js';

dotenv.config();

async function runMigrations(): Promise<void> {
  try {
    console.log('Starting database migrations...');

    await connectDB();

    // Create users table
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✓ Users table created');

    // Create trades table
    await query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        trade_type VARCHAR(10) NOT NULL CHECK (trade_type IN ('BUY', 'SELL')),
        quantity DECIMAL(20, 8) NOT NULL,
        price DECIMAL(20, 8) NOT NULL,
        total DECIMAL(20, 8) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'PENDING'
      );
    `);
    console.log('✓ Trades table created');

    // Create price_data table for market data
    await query(`
      CREATE TABLE IF NOT EXISTS price_data (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        price DECIMAL(20, 8) NOT NULL,
        volume DECIMAL(20, 8),
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✓ Price data table created');

    // Create indexes
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_price_data_symbol ON price_data(symbol);
      CREATE INDEX IF NOT EXISTS idx_price_data_timestamp ON price_data(timestamp);
    `);
    console.log('✓ Indexes created');

    console.log('Database migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await closeDB();
  }
}

runMigrations().catch((error) => {
  console.error('Fatal error during migration:', error);
  process.exit(1);
});
