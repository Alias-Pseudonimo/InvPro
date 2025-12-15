import { Pool } from 'pg';

// Database connection configuration using environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Fallback to individual env vars if DATABASE_URL is not set
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'inventory_management',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export const query = (text: string, params?: any[]) => {
  return pool.query(text, params);
};

export const getClient = () => {
  return pool.connect();
};