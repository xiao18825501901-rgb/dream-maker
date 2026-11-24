-- Selected configuration is separate from plan/build approval, credentials and qualification.
CREATE TABLE engineering_profiles (
 project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 128),
 operation_hash TEXT NOT NULL, sha256 TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data)<=131072),
 PRIMARY KEY(project_id,revision), UNIQUE(project_id,operation_hash)
);
CREATE TRIGGER engineering_profiles_no_update BEFORE UPDATE ON engineering_profiles
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENGINEERING_PROFILE'); END;
CREATE TRIGGER engineering_profiles_no_delete BEFORE DELETE ON engineering_profiles
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENGINEERING_PROFILE'); END;
CREATE TRIGGER engineering_profiles_no_replace BEFORE INSERT ON engineering_profiles
 WHEN EXISTS(SELECT 1 FROM engineering_profiles WHERE rowid=NEW.rowid
  OR (project_id=NEW.project_id AND (revision=NEW.revision OR operation_hash=NEW.operation_hash)))
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENGINEERING_PROFILE'); END;
