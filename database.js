import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`[DB] Created directory: ${dbDir}`);
}

// Use WAL mode for better concurrency and performance
const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

function initialize() {
  console.log("[DB] Initializing and verifying database schema...");

  db.exec(`
       CREATE TABLE IF NOT EXISTS messages (
           id INTEGER PRIMARY KEY, -- Telegram Message ID
           source_channel_id TEXT NOT NULL,
           message_text TEXT NOT NULL,
           reply_to_id INTEGER,
           events_json TEXT,
           raw_llm_response TEXT,
           full_telegram_update_json TEXT,
           created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       );
       CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (source_channel_id);
   `);

  db.exec(`
        CREATE TABLE IF NOT EXISTS geocoding_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           message_id INTEGER NOT NULL,
           location_name TEXT NOT NULL,
           latitude REAL,
           longitude REAL,
           success INTEGER NOT NULL CHECK (success IN (0, 1)),
           timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
           FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
       );
        CREATE INDEX IF NOT EXISTS idx_geo_message ON geocoding_log (message_id);
   `);
  db.exec(`
       CREATE TABLE IF NOT EXISTS map_generation_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           message_id INTEGER NOT NULL UNIQUE, -- One map per message
           screenshot_path TEXT,
           plottable_objects_json TEXT, 
           view_parameters_json TEXT, 
           timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
       );
   `);

  // FIX: Ensure the table is created *before* attempting to alter it.
  // This statement creates the table with ALL columns for new databases.
  // For old databases (pre-direction), this statement does nothing.
  db.exec(`
       CREATE TABLE IF NOT EXISTS world_state (
           object_id TEXT PRIMARY KEY, -- Using UUID
           quantity INTEGER NOT NULL,
           item TEXT NOT NULL,
           "from" TEXT NOT NULL,
           "to" TEXT NOT NULL,
           direction TEXT,
           updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
       );
   `);

  // FIX: Now, safely attempt to migrate old databases by adding the 'direction' column.
  // This block will only run if the column is missing (on old DBs).
  // It will not error on new DBs where the column already exists.
  try {
    db.prepare("SELECT direction FROM world_state LIMIT 1").get();
  } catch (e) {
    // Only alter the table if the specific error is "no such column".
    if (e.message.includes("no such column")) {
      console.log(
        "[DB] Migrating schema: Adding 'direction' column to world_state table..."
      );
      db.exec("ALTER TABLE world_state ADD COLUMN direction TEXT");
    } else {
      // For any other error, re-throw it so we know about it.
      throw e;
    }
  }

  console.log("[DB] Schema is ready.");
}

initialize();

const insertMessageStmt = db.prepare(
  `INSERT OR REPLACE INTO messages (id, source_channel_id, message_text, reply_to_id, events_json, raw_llm_response, full_telegram_update_json)
    VALUES (@id, @source_channel_id, @message_text, @reply_to_id, @events_json, @raw_llm_response, @full_telegram_update_json)`
);
export const logMessage = db.transaction((log) => {
  insertMessageStmt.run({
    ...log,
    events_json: JSON.stringify(log.events_json),
    full_telegram_update_json: JSON.stringify(log.full_telegram_update_json),
  });
});

const insertGeocodingLogStmt = db.prepare(
  `INSERT INTO geocoding_log (message_id, location_name, latitude, longitude, success) VALUES (@message_id, @location_name, @latitude, @longitude, @success)`
);
export const logGeocodingAttempt = db.transaction((log) => {
  insertGeocodingLogStmt.run(log);
});

const insertOrReplaceMapLogStmt = db.prepare(
  `INSERT OR REPLACE INTO map_generation_log (message_id, screenshot_path, plottable_objects_json, view_parameters_json) 
     VALUES (@message_id, @screenshot_path, @plottable_objects_json, @view_parameters_json)`
);
export const logMapGeneration = db.transaction((log) => {
  insertOrReplaceMapLogStmt.run({
    ...log,
    plottable_objects_json: JSON.stringify(log.plottable_objects_json),
    view_parameters_json: JSON.stringify(log.view_parameters_json),
  });
});

const getStateStmt = db.prepare(
  'SELECT object_id as id, quantity, item, "from", "to", direction FROM world_state'
);
const clearStateStmt = db.prepare("DELETE FROM world_state");
const insertStateObjectStmt = db.prepare(
  `INSERT INTO world_state (object_id, quantity, item, "from", "to", direction, updated_at) VALUES (@id, @quantity, @item, @from, @to, @direction, CURRENT_TIMESTAMP)`
);

export function loadWorldState() {
  try {
    return getStateStmt.all();
  } catch (e) {
    console.error("[DB] Error loading state:", e);
    return [];
  }
}

export const saveWorldState = db.transaction((activeObjects) => {
  clearStateStmt.run();
  for (const obj of activeObjects) {
    insertStateObjectStmt.run({
      id: obj.id,
      quantity: obj.quantity,
      item: obj.item,
      from: obj.from,
      to: obj.to,
      direction: obj.direction || null,
    });
  }
});

export default db;
