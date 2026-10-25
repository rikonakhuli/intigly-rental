"use strict";
// Persistence layer. Zero npm deps.
//
// Today: JsonDb keeps every table in memory and writes the whole file atomically
// (tmp file + rename) on each mutation. This is the fallback that works on Render
// free tier, whose disk is ephemeral (data resets on redeploy, see README).
//
// Upgrade path: the interface below (insert / find / filter / update / transaction)
// is the only thing server.js uses. Swap JsonDb for a SqliteDb (node:sqlite on Node 22.5+,
// or better-sqlite3) or a PgDb (Render Postgres / Supabase) that implements the same
// methods. The table shapes are written out in db/schema.sql.

const fs = require("fs");
const path = require("path");

const TABLES = ["users", "sessions", "listings", "media", "orders", "ledger", "reveals"];

class JsonDb {
  constructor(file) {
    this.file = file;
    this.data = {};
    TABLES.forEach((t) => (this.data[t] = []));
    this.load();
  }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      TABLES.forEach((t) => (this.data[t] = Array.isArray(parsed[t]) ? parsed[t] : []));
    } catch (e) {
      // no file yet, or unreadable: start empty
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  insert(table, row) {
    this.data[table].push(row);
    this.save();
    return row;
  }
  find(table, pred) {
    return this.data[table].find(pred) || null;
  }
  filter(table, pred) {
    return this.data[table].filter(pred);
  }
  update(table, pred, patch) {
    const row = this.find(table, pred);
    if (row) {
      Object.assign(row, patch);
      this.save();
    }
    return row;
  }
  // Runs fn synchronously. Node is single-threaded here, so nothing else interleaves.
  // On Postgres this becomes BEGIN / SELECT ... FOR UPDATE / COMMIT.
  transaction(fn) {
    const snapshot = JSON.stringify(this.data);
    try {
      const out = fn(this);
      this.save();
      return out;
    } catch (e) {
      this.data = JSON.parse(snapshot);
      throw e;
    }
  }
}

function createDb() {
  const dir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  return new JsonDb(path.join(dir, "db.json"));
}

module.exports = { createDb, TABLES };
