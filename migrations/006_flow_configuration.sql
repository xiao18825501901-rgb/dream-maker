-- Preserve every historical row. Only new explicit engineering modes carry this snapshot.
CREATE TRIGGER runs_flow_config_required BEFORE INSERT ON runs
 WHEN json_extract(NEW.data,'$.flowName') IN ('classic','custom')
  AND (json_type(NEW.data,'$.flowConfig') IS NOT 'object' OR json_type(NEW.data,'$.flowConfigHash') IS NOT 'text')
 BEGIN SELECT RAISE(ABORT,'FLOW_CONFIG_REQUIRED'); END;
CREATE TRIGGER runs_flow_config_immutable BEFORE UPDATE ON runs
 WHEN json_type(OLD.data,'$.flowConfig') IS NOT NULL
  AND (OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id
   OR json_type(OLD.data,'$.flowConfig') IS NOT json_type(NEW.data,'$.flowConfig')
   OR json_extract(OLD.data,'$.flowConfig') IS NOT json_extract(NEW.data,'$.flowConfig')
   OR json_extract(OLD.data,'$.flowConfigHash') IS NOT json_extract(NEW.data,'$.flowConfigHash')
   OR json_extract(OLD.data,'$.flowName') IS NOT json_extract(NEW.data,'$.flowName'))
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FLOW_CONFIG'); END;
CREATE TRIGGER runs_flow_config_no_replace BEFORE INSERT ON runs
 WHEN EXISTS(SELECT 1 FROM runs WHERE (id=NEW.id OR rowid=NEW.rowid) AND json_type(data,'$.flowConfig') IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FLOW_CONFIG'); END;
CREATE TRIGGER runs_flow_config_no_delete BEFORE DELETE ON runs
 WHEN json_type(OLD.data,'$.flowConfig') IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FLOW_CONFIG'); END;
-- Identity moves can REPLACE a different row without DELETE triggers when recursion is OFF.
-- The original Store updates only version/data, never a run's id, rowid or project identity.
CREATE TRIGGER runs_identity_immutable BEFORE UPDATE ON runs
 WHEN OLD.id IS NOT NEW.id OR OLD.rowid IS NOT NEW.rowid OR OLD.project_id IS NOT NEW.project_id
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FLOW_CONFIG'); END;
-- SQLite selects the first duplicate key; JSON.parse selects the last. Keep one interpretation.
CREATE TRIGGER runs_json_unambiguous_insert BEFORE INSERT ON runs
 WHEN json_valid(NEW.data)<>1 OR json_type(NEW.data) IS NOT 'object'
  OR EXISTS(SELECT 1 FROM json_each(NEW.data) GROUP BY key HAVING COUNT(*)>1)
 BEGIN SELECT RAISE(ABORT,'FLOW_CONFIG_JSON_AMBIGUOUS'); END;
CREATE TRIGGER runs_json_unambiguous_update BEFORE UPDATE ON runs
 WHEN json_valid(NEW.data)<>1 OR json_type(NEW.data) IS NOT 'object'
  OR EXISTS(SELECT 1 FROM json_each(NEW.data) GROUP BY key HAVING COUNT(*)>1)
 BEGIN SELECT RAISE(ABORT,'FLOW_CONFIG_JSON_AMBIGUOUS'); END;
