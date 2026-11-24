-- REPLACE can skip DELETE triggers when recursive_triggers is off. Reject duplicate inserts first.
CREATE TRIGGER IF NOT EXISTS managed_dataset_versions_no_replace BEFORE INSERT ON managed_dataset_versions
 WHEN EXISTS(SELECT 1 FROM managed_dataset_versions WHERE project_id=NEW.project_id AND kind=NEW.kind AND revision=NEW.revision)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DATA_VERSION'); END;
CREATE TRIGGER IF NOT EXISTS managed_dataset_operations_no_replace BEFORE INSERT ON managed_dataset_operations
 WHEN EXISTS(SELECT 1 FROM managed_dataset_operations WHERE operation_hash=NEW.operation_hash)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DATA_OPERATION'); END;
CREATE TRIGGER IF NOT EXISTS state_snapshot_anchors_no_replace BEFORE INSERT ON state_snapshot_anchors
 WHEN EXISTS(SELECT 1 FROM state_snapshot_anchors WHERE snapshot_id=NEW.snapshot_id)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SNAPSHOT_ANCHOR'); END;
