CREATE TABLE plan_versions(
 id TEXT PRIMARY KEY REFERENCES specs(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 parent_id TEXT REFERENCES plan_versions(id),
 spec_hash TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('LEGACY_IMPORTED','COMPILED_SPEC','COMPLETE_PLAN')),
 snapshot TEXT NOT NULL,
 source TEXT NOT NULL,
 at TEXT NOT NULL,
 UNIQUE(project_id,revision)
);
CREATE TABLE plan_version_approvals(
 plan_id TEXT PRIMARY KEY REFERENCES plan_versions(id),
 spec_hash TEXT NOT NULL,
 actor TEXT NOT NULL,
 at TEXT NOT NULL
);
CREATE TRIGGER plan_versions_no_update BEFORE UPDATE ON plan_versions
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PLAN'); END;
CREATE TRIGGER plan_versions_no_delete BEFORE DELETE ON plan_versions
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PLAN'); END;
CREATE TRIGGER plan_approvals_no_update BEFORE UPDATE ON plan_version_approvals
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PLAN_APPROVAL'); END;
CREATE TRIGGER plan_approvals_no_delete BEFORE DELETE ON plan_version_approvals
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PLAN_APPROVAL'); END;
