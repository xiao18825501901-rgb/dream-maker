PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  BEGIN IMMEDIATE;
  CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT OR IGNORE INTO schema_versions VALUES(1,datetime('now'));
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS specs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),hash TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT,run_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS events_project_cursor ON events(project_id,id);
  CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
  CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,project_id TEXT,run_id TEXT,data TEXT NOT NULL,at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS records_owner_kind ON records(project_id,run_id,kind);
  CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),spec_hash TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workspace_leases(project_id TEXT PRIMARY KEY REFERENCES projects(id),run_id TEXT NOT NULL,acquired_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status TEXT NOT NULL,response TEXT,at TEXT NOT NULL);
  
COMMIT;
