import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const databasePath = path.join(dataDir, "zephikyu.db");
const migrationsDir = path.resolve("prisma/migrations");
fs.mkdirSync(dataDir, { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS _app_migrations (name TEXT NOT NULL PRIMARY KEY, appliedAt TEXT NOT NULL);");
const applied = database.prepare("SELECT 1 FROM _app_migrations WHERE name = ?");
const record = database.prepare("INSERT INTO _app_migrations (name, appliedAt) VALUES (?, ?)");
const migrations = fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

for (const name of migrations) {
  if (applied.get(name)) continue;
  const sql = fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec(sql);
    record.run(name, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

database.exec("PRAGMA optimize");
database.close();
