-- Extend the original Store-owned version/head/operation tables; no second data authority.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER IF EXISTS managed_dataset_versions_no_update;
DROP TRIGGER IF EXISTS managed_dataset_versions_no_delete;
DROP TRIGGER IF EXISTS managed_dataset_versions_no_replace;
DROP TRIGGER IF EXISTS managed_dataset_operations_no_update;
DROP TRIGGER IF EXISTS managed_dataset_operations_no_delete;
DROP TRIGGER IF EXISTS managed_dataset_operations_no_replace;
DROP INDEX managed_dataset_operation_scope;
ALTER TABLE managed_dataset_heads RENAME TO managed_dataset_heads_v4;
ALTER TABLE managed_dataset_operations RENAME TO managed_dataset_operations_v4;
ALTER TABLE managed_dataset_versions RENAME TO managed_dataset_versions_v4;
CREATE TABLE managed_dataset_versions(
 project_id TEXT NOT NULL REFERENCES projects(id),
 kind TEXT NOT NULL CHECK(kind IN ('FIXED_DEMO_TASKS_V1','JSON_DOCUMENT_V1','SQLITE_IMAGE_V1')),
 revision INTEGER NOT NULL CHECK(revision>0),parent_revision INTEGER,parent_hash TEXT,
 data_json TEXT NOT NULL CHECK(length(CAST(data_json AS BLOB))<=100000),
 data_hash TEXT NOT NULL CHECK(length(data_hash)=64),content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 source_run_id TEXT NOT NULL REFERENCES runs(id),source_tree_hash TEXT NOT NULL CHECK(length(source_tree_hash)=64),
 origin TEXT NOT NULL CHECK(origin IN ('PREVIEW_EDIT','BROWSER_IMPORT','LOCAL_DATA_EDIT','JSON_IMPORT','RUNTIME_RESULT','RESTORE','SQLITE_RUNTIME_RESULT')),
 source_snapshot_id TEXT,actor TEXT NOT NULL,at TEXT NOT NULL,
 PRIMARY KEY(project_id,kind,revision),
 FOREIGN KEY(project_id,kind,parent_revision) REFERENCES managed_dataset_versions(project_id,kind,revision),
 CHECK((revision=1 AND parent_revision IS NULL AND parent_hash IS NULL) OR (revision>1 AND parent_revision=revision-1 AND length(parent_hash)=64)),
 CHECK((origin='RESTORE' AND source_snapshot_id IS NOT NULL) OR (origin!='RESTORE' AND source_snapshot_id IS NULL))
);
CREATE TABLE managed_dataset_heads(
 project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,revision INTEGER NOT NULL,
 PRIMARY KEY(project_id,kind),FOREIGN KEY(project_id,kind,revision) REFERENCES managed_dataset_versions(project_id,kind,revision)
);
CREATE TABLE managed_dataset_operations(
 operation_hash TEXT PRIMARY KEY CHECK(length(operation_hash)=64),project_id TEXT NOT NULL,kind TEXT NOT NULL,
 input_hash TEXT NOT NULL CHECK(length(input_hash)=64),applied_revision INTEGER NOT NULL,at TEXT NOT NULL,
 FOREIGN KEY(project_id,kind,applied_revision) REFERENCES managed_dataset_versions(project_id,kind,revision)
);
CREATE INDEX managed_dataset_operation_scope ON managed_dataset_operations(project_id,kind);
INSERT INTO managed_dataset_versions SELECT * FROM managed_dataset_versions_v4 ORDER BY project_id,kind,revision;
INSERT INTO managed_dataset_heads SELECT * FROM managed_dataset_heads_v4;
INSERT INTO managed_dataset_operations SELECT * FROM managed_dataset_operations_v4;
DROP TABLE managed_dataset_operations_v4;
DROP TABLE managed_dataset_heads_v4;
DROP TABLE managed_dataset_versions_v4;
CREATE TRIGGER managed_dataset_versions_no_update BEFORE UPDATE ON managed_dataset_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DATA_VERSION'); END;
CREATE TRIGGER managed_dataset_versions_no_delete BEFORE DELETE ON managed_dataset_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DATA_VERSION'); END;
CREATE TRIGGER managed_dataset_operations_no_update BEFORE UPDATE ON managed_dataset_operations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DATA_OPERATION'); END;
CREATE TRIGGER managed_dataset_operations_no_delete BEFORE DELETE ON managed_dataset_operations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DATA_OPERATION'); END;
-- Intents are written before touching image bytes and never rewritten. Original operation rows
-- prove publication. An intent without its operation remains uncertain across process restart.
CREATE TABLE business_image_intents(
 operation_hash TEXT PRIMARY KEY CHECK(length(operation_hash)=64),
 project_id TEXT NOT NULL REFERENCES projects(id),source_run_id TEXT NOT NULL REFERENCES runs(id),
 source_tree_hash TEXT NOT NULL CHECK(length(source_tree_hash)=64),
 input_hash TEXT NOT NULL CHECK(length(input_hash)=64),expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 image_hash TEXT NOT NULL CHECK(length(image_hash)=64),image_bytes INTEGER NOT NULL CHECK(image_bytes BETWEEN 512 AND 67108864),
 actor TEXT NOT NULL,at TEXT NOT NULL
);
CREATE TRIGGER business_image_intents_no_update BEFORE UPDATE ON business_image_intents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IMAGE_INTENT'); END;
CREATE TRIGGER business_image_intents_no_delete BEFORE DELETE ON business_image_intents BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IMAGE_INTENT'); END;
CREATE TRIGGER business_image_intents_no_replace BEFORE INSERT ON business_image_intents WHEN EXISTS(SELECT 1 FROM business_image_intents WHERE operation_hash=NEW.operation_hash) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IMAGE_INTENT'); END;
