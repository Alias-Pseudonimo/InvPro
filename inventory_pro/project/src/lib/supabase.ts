import { createClient } from '@supabase/supabase-js';

// Get Supabase credentials from environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Create Supabase client only if credentials are available
export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Database service that uses Supabase when available, localStorage as fallback
export class DatabaseService {
  static async get<T>(table: string, defaultValue: T): Promise<T> {
    if (supabase) {
      try {
        const { data, error } = await supabase.from(table).select('*');
        if (error) throw error;
        return data as T || defaultValue;
      } catch (error) {
        console.error(`Error fetching from ${table}:`, error);
        return LocalStorageDB.get(table, defaultValue);
      }
    }
    return LocalStorageDB.get(table, defaultValue);
  }

  static async set<T>(table: string, value: T): Promise<void> {
    if (supabase) {
      try {
        // For arrays, we need to handle insert/update differently
        if (Array.isArray(value)) {
          // Clear existing data and insert new
          await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
          if (value.length > 0) {
            const { error } = await supabase.from(table).insert(value);
            if (error) throw error;
          }
        } else {
          // For single objects, use upsert
          const { error } = await supabase.from(table).upsert(value);
          if (error) throw error;
        }
      } catch (error) {
        console.error(`Error saving to ${table}:`, error);
        LocalStorageDB.set(table, value);
      }
    } else {
      LocalStorageDB.set(table, value);
    }
  }

  static async insert<T>(table: string, value: T): Promise<T | null> {
    if (supabase) {
      try {
        const { data, error } = await supabase.from(table).insert(value).select().single();
        if (error) throw error;
        return data;
      } catch (error) {
        console.error(`Error inserting into ${table}:`, error);
        return null;
      }
    }
    return null;
  }

  static async update<T>(table: string, id: string, value: Partial<T>): Promise<T | null> {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from(table)
          .update({ ...value, updated_at: new Date().toISOString() })
          .eq('id', id)
          .select()
          .single();
        if (error) throw error;
        return data;
      } catch (error) {
        console.error(`Error updating ${table}:`, error);
        return null;
      }
    }
    return null;
  }

  static async delete(table: string, id: string): Promise<boolean> {
    if (supabase) {
      try {
        const { error } = await supabase.from(table).delete().eq('id', id);
        if (error) throw error;
        return true;
      } catch (error) {
        console.error(`Error deleting from ${table}:`, error);
        return false;
      }
    }
    return false;
  }
}

// Fallback localStorage database for when Supabase is not available
export class LocalStorageDB {
  static get<T>(key: string, defaultValue: T): T {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  static set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error('Failed to save to localStorage:', error);
    }
  }

  static remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('Failed to remove from localStorage:', error);
    }
  }
}