-- Append-only additions only. Historical records and run states are unchanged.
-- Pin the actual assigned rowid after insertion. BEFORE INSERT uses -1 for an
-- unassigned rowid, so comparing it there can reject unrelated ordinary inserts.
CREATE TABLE prework_record_identities(
 record_id TEXT PRIMARY KEY NOT NULL,
 record_rowid INTEGER UNIQUE NOT NULL
) WITHOUT ROWID;
INSERT INTO prework_record_identities(record_id,record_rowid)
 SELECT id,rowid FROM records WHERE kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout');
CREATE TRIGGER prework_identity_no_update BEFORE UPDATE ON prework_record_identities
BEGIN SELECT RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE'); END;
CREATE TRIGGER prework_identity_no_delete BEFORE DELETE ON prework_record_identities
BEGIN SELECT RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE'); END;
CREATE TRIGGER prework_identity_no_replace BEFORE INSERT ON prework_record_identities
WHEN EXISTS(SELECT 1 FROM prework_record_identities WHERE record_id=NEW.record_id OR record_rowid=NEW.record_rowid)
 OR NOT EXISTS(SELECT 1 FROM records WHERE id=NEW.record_id AND rowid=NEW.record_rowid AND kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout'))
BEGIN SELECT RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE'); END;
CREATE TRIGGER prework_record_no_update BEFORE UPDATE ON records
WHEN OLD.kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout')
 OR NEW.kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout')
 OR EXISTS(SELECT 1 FROM records r WHERE r.kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout') AND (r.id=NEW.id OR r.rowid=NEW.rowid))
BEGIN SELECT RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE'); END;
CREATE TRIGGER prework_record_no_delete BEFORE DELETE ON records
WHEN OLD.kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout')
BEGIN SELECT RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE'); END;
CREATE TRIGGER prework_record_no_replace BEFORE INSERT ON records
WHEN EXISTS(
 SELECT 1 FROM records r
 WHERE r.kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout') AND (
  r.id=NEW.id OR
  (NEW.kind='PreworkContract' AND r.kind='PreworkContract' AND r.run_id=NEW.run_id AND
   json_extract(r.data,'$.contract.contractId')=json_extract(NEW.data,'$.contract.contractId')) OR
  (NEW.kind='PreworkPackageResult' AND r.kind='PreworkPackageResult' AND r.run_id=NEW.run_id AND
   json_extract(r.data,'$.dispatchId')=json_extract(NEW.data,'$.dispatchId'))
 ))
BEGIN SELECT RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE'); END;
CREATE TRIGGER prework_record_rowid_guard AFTER INSERT ON records
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM prework_record_identities WHERE record_rowid=NEW.rowid AND record_id IS NOT NEW.id)
  THEN RAISE(ABORT,'PREWORK_RECORD_IMMUTABLE') END;
 INSERT INTO prework_record_identities(record_id,record_rowid)
  SELECT NEW.id,NEW.rowid WHERE NEW.kind IN ('PreworkContract','PreworkPackageResult','PreworkCloseout');
END;
CREATE UNIQUE INDEX prework_contract_identity ON records(run_id,json_extract(data,'$.contract.contractId')) WHERE kind='PreworkContract';
CREATE UNIQUE INDEX prework_result_dispatch ON records(run_id,json_extract(data,'$.dispatchId')) WHERE kind='PreworkPackageResult';
