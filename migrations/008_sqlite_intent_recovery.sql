-- Persist the trusted publication identity before any image bytes are written.
-- The Intent remains immutable; a successful recovery creates the original
-- managed_dataset_operations row instead of rewriting or deleting the Intent.
CREATE TABLE business_image_intent_bindings(
 operation_hash TEXT PRIMARY KEY REFERENCES business_image_intents(operation_hash),
 capture_input_hash TEXT NOT NULL CHECK(length(capture_input_hash)=64),
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
 result_hash TEXT NOT NULL CHECK(length(result_hash)=64),
 worker_job_id TEXT NOT NULL CHECK(length(worker_job_id) BETWEEN 1 AND 200),
 snapshot_helper_hash TEXT NOT NULL CHECK(length(snapshot_helper_hash)=64),
 sqlite_version TEXT NOT NULL CHECK(length(sqlite_version) BETWEEN 5 AND 40),
 created_at TEXT NOT NULL
);
CREATE TRIGGER business_image_intent_bindings_no_update
BEFORE UPDATE ON business_image_intent_bindings
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IMAGE_INTENT_BINDING'); END;
CREATE TRIGGER business_image_intent_bindings_no_delete
BEFORE DELETE ON business_image_intent_bindings
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IMAGE_INTENT_BINDING'); END;
CREATE TRIGGER business_image_intent_bindings_no_replace
BEFORE INSERT ON business_image_intent_bindings
WHEN EXISTS(SELECT 1 FROM business_image_intent_bindings WHERE operation_hash=NEW.operation_hash)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IMAGE_INTENT_BINDING'); END;
