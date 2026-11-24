import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DomainError, id, now, hash, redact } from './security.js';
import type { Project, Run, Spec, Event, PlanVersion } from '../shared/types.js';
import { projectPlanInput } from './plan-input.js';
import {migrationBackup} from './migration-backup.js';
import {assertFlowSnapshot} from './flow-configuration.js';
export const APPLICATION_SCHEMA_VERSION=9;
export class Store {
    db: DatabaseSync;
    private transactionOpen = false;
    /** Original synchronous transaction ownership, for atomic composed writes. */
    get inTransaction():boolean { return this.transactionOpen; }
    constructor(public readonly path: string) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'").get();
        const version = existing ? Number(this.db.prepare('SELECT MAX(version) v FROM schema_versions').get()?.v) : 0;
        if (version > APPLICATION_SCHEMA_VERSION) {
            this.db.close();
            throw new DomainError('DATABASE_NEWER_THAN_RUNTIME', 409);
        }
        this.db.exec(readFileSync(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8'));
        if (version < 2) {
            try {
                if (version === 1 && path !== ':memory:') {
                    migrationBackup(this.db,path,2);
                }
                this.tx(() => {
                    this.db.exec(readFileSync(new URL('../../migrations/002_plan_versions.sql', import.meta.url), 'utf8'));
                    for (const row of this.db.prepare('SELECT data FROM specs ORDER BY rowid').all())
                        this.capturePlanVersion(JSON.parse(row.data as string), 'LEGACY_IMPORTED');
                    this.db.prepare('INSERT INTO schema_versions VALUES(2,?)').run(now());
                });
            } catch (error) { this.db.close(); throw error; }
        }
        if(version<3){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,3);
                this.tx(()=>{this.db.exec(readFileSync(new URL('../../migrations/003_managed_data.sql',import.meta.url),'utf8'));this.db.exec(readFileSync(new URL('../../migrations/003_managed_data_guards.sql',import.meta.url),'utf8'));this.db.prepare('INSERT INTO schema_versions VALUES(3,?)').run(now());});
            }catch(error){this.db.close();throw error;}
        }
        else if(Number(this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('managed_dataset_versions_no_replace','managed_dataset_operations_no_replace','state_snapshot_anchors_no_replace')").get()?.n)!==3){
            try{if(path!==':memory:')migrationBackup(this.db,path,3);this.tx(()=>this.db.exec(readFileSync(new URL('../../migrations/003_managed_data_guards.sql',import.meta.url),'utf8')));}catch(error){this.db.close();throw error;}
        }
        if(version<4){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,4);
                this.tx(()=>{
                    this.db.exec(readFileSync(new URL('../../migrations/004_json_business_data.sql',import.meta.url),'utf8'));
                    this.db.exec(readFileSync(new URL('../../migrations/003_managed_data_guards.sql',import.meta.url),'utf8'));
                    if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new DomainError('MANAGED_DATA_MIGRATION_INTEGRITY_FAILED',409);
                    this.db.prepare('INSERT INTO schema_versions VALUES(4,?)').run(now());
                });
            }catch(error){this.db.close();throw error;}
        }
        if(version<5){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,5);
                this.tx(()=>{
                    this.db.exec(readFileSync(new URL('../../migrations/005_sqlite_business_data.sql',import.meta.url),'utf8'));
                    this.db.exec(readFileSync(new URL('../../migrations/003_managed_data_guards.sql',import.meta.url),'utf8'));
                    if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new DomainError('MANAGED_DATA_MIGRATION_INTEGRITY_FAILED',409);
                    this.db.prepare('INSERT INTO schema_versions VALUES(5,?)').run(now());
                });
            }catch(error){this.db.close();throw error;}
        }
        if(version<6){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,6);
                this.tx(()=>{this.db.exec(readFileSync(new URL('../../migrations/006_flow_configuration.sql',import.meta.url),'utf8'));this.db.prepare('INSERT INTO schema_versions VALUES(6,?)').run(now());});
            }catch(error){this.db.close();throw error;}
        }
        if(version<7){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,7);
                this.tx(()=>{this.db.exec(readFileSync(new URL('../../migrations/007_engineering_profiles.sql',import.meta.url),'utf8'));this.db.prepare('INSERT INTO schema_versions VALUES(7,?)').run(now());});
            }catch(error){this.db.close();throw error;}
        }
        if(version<8){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,8);
                this.tx(()=>{this.db.exec(readFileSync(new URL('../../migrations/008_sqlite_intent_recovery.sql',import.meta.url),'utf8'));this.db.prepare('INSERT INTO schema_versions VALUES(8,?)').run(now());});
            }catch(error){this.db.close();throw error;}
        }
        if(version<9){
            try{
                if(version>=1&&path!==':memory:')migrationBackup(this.db,path,9);
                this.tx(()=>{this.db.exec(readFileSync(new URL('../../migrations/009_prework_records.sql',import.meta.url),'utf8'));this.db.prepare('INSERT INTO schema_versions VALUES(9,?)').run(now());});
            }catch(error){this.db.close();throw error;}
        }
        if (path !== ':memory:')
            try {
                chmodSync(path, 0o600);
            }
            catch { }
    }
    tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); this.transactionOpen = true; try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } finally { this.transactionOpen = false; } }
    project(pid: string): Project { const r = this.db.prepare('SELECT data FROM projects WHERE id=?').get(pid); if (!r)
        throw new DomainError('PROJECT_NOT_FOUND', 404); return JSON.parse(r.data as string); }
    projects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all().map(r => JSON.parse(r.data as string)); }
    insertProject(p: Project) { this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id, p.version, JSON.stringify(p)); }
    saveProject(p: Project, expected = p.version) { p.version = expected + 1; p.updatedAt = now(); const r = this.db.prepare('UPDATE projects SET version=?,data=? WHERE id=? AND version=?').run(p.version, JSON.stringify(p), p.id, expected); if (!r.changes)
        throw new DomainError('STALE_PROJECT_VERSION', 409); }
    spec(sid: string): Spec {
        const r = this.db.prepare('SELECT data FROM specs WHERE id=?').get(sid);
        if (!r) throw new DomainError('SPEC_NOT_FOUND', 404);
        const value = JSON.parse(r.data as string) as Spec;
        const { stale: _currentStale, ...current } = value;
        const { stale: _snapshotStale, ...snapshot } = this.planVersion(sid).snapshot;
        if (hash(current) !== hash(snapshot)) throw new DomainError('PLAN_INTEGRITY_FAILED', 409);
        return value;
    }
    saveSpec(s: Spec, expectedParentId: string | null = null) {
        const work = () => {
            const old = this.db.prepare('SELECT data FROM specs WHERE id=?').get(s.id);
            if (old) {
                const { stale: _oldStale, ...before } = JSON.parse(old.data as string) as Spec;
                const { stale: _newStale, ...after } = s;
                if (hash(before) !== hash(after)) throw new DomainError('IMMUTABLE_PLAN', 409);
                this.db.prepare('UPDATE specs SET data=? WHERE id=?').run(JSON.stringify(s), s.id);
                return;
            }
            const p = this.project(s.projectId);
            if (p.version !== s.projectVersion) throw new DomainError('STALE_PLAN_INPUT', 409);
            const parent = this.planHead(p.id);
            if ((parent?.id ?? null) !== expectedParentId) throw new DomainError('STALE_PLAN_PARENT', 409);
            if (!Number.isSafeInteger(s.revision) || s.revision !== (parent?.revision ?? 0) + 1) throw new DomainError('INVALID_PLAN_REVISION', 409);
            if (this.db.prepare('SELECT 1 FROM workspace_leases WHERE project_id=?').get(p.id)
                || this.runs(p.id).some(r => ['PLANNING','IMPLEMENTING','VERIFYING','REVIEWING','REPAIRING','PAUSE_REQUESTED','PAUSED','CANCEL_REQUESTED'].includes(r.state)))
                throw new DomainError('RUN_MUST_STOP_BEFORE_EDIT', 409);
            this.db.prepare('INSERT INTO specs VALUES(?,?,?,?)').run(s.id, s.projectId, s.hash, JSON.stringify(s));
            this.capturePlanVersion(s, s.projectPlan ? 'COMPLETE_PLAN' : 'COMPILED_SPEC');
        };
        if (this.transactionOpen) work(); else this.tx(work);
    }
    private capturePlanVersion(s: Spec, origin: PlanVersion['origin']) {
        const parent = this.db.prepare('SELECT id FROM plan_versions WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(s.projectId);
        const p = this.project(s.projectId);
        const source: PlanVersion['source'] = origin === 'LEGACY_IMPORTED' ? { provenance: 'EXISTING_SPEC_BYTES' }
            : { provenance: 'CURRENT_PROJECT_INPUT', ...projectPlanInput(p) };
        const identity = { id: s.id, projectId: s.projectId, revision: s.revision, parentId: parent?.id as string ?? null, specHash: s.hash, origin, snapshot: s, source };
        this.db.prepare('INSERT INTO plan_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(s.id, s.projectId, s.revision, identity.parentId, s.hash, hash(identity), origin, JSON.stringify(s), JSON.stringify(source), s.createdAt);
    }
    planVersion(sid: string): PlanVersion {
        const row = this.db.prepare('SELECT * FROM plan_versions WHERE id=?').get(sid);
        if (!row) throw new DomainError('PLAN_VERSION_NOT_FOUND', 404);
        const value = { id: row.id as string, projectId: row.project_id as string, revision: Number(row.revision), parentId: row.parent_id as string | null, specHash: row.spec_hash as string, origin: row.origin as PlanVersion['origin'], snapshot: JSON.parse(row.snapshot as string) as Spec, source: JSON.parse(row.source as string) as PlanVersion['source'] };
        if (hash(value) !== row.content_hash) throw new DomainError('PLAN_INTEGRITY_FAILED', 409);
        const approval = this.db.prepare('SELECT * FROM plan_version_approvals WHERE plan_id=?').get(sid);
        return { ...value, contentHash: row.content_hash as string, createdAt: row.at as string, approval: approval ? { actor: approval.actor as string, at: approval.at as string } : null };
    }
    planVersions(pid: string, afterRevision = 0, limit = 50): PlanVersion[] {
        this.project(pid);
        return this.db.prepare('SELECT id FROM plan_versions WHERE project_id=? AND revision>? ORDER BY revision LIMIT ?').all(pid, afterRevision, limit).map(row => this.planVersion(row.id as string));
    }
    planHead(pid: string): PlanVersion | null {
        const row = this.db.prepare('SELECT id FROM plan_versions WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(pid);
        return row ? this.planVersion(row.id as string) : null;
    }
    specs(pid: string): Spec[] { return this.db.prepare('SELECT id FROM specs WHERE project_id=? ORDER BY rowid').all(pid).map(r => this.spec(r.id as string)); }
    run(rid: string): Run { const r = this.db.prepare('SELECT data FROM runs WHERE id=?').get(rid); if (!r)
        throw new DomainError('RUN_NOT_FOUND', 404); return this.decodeRun(r.data as string); }
    private decodeRun(data:string):Run{const run=JSON.parse(data) as Run;assertFlowSnapshot(run);return run;}
    runs(pid?: string): Run[] { return (pid ? this.db.prepare('SELECT data FROM runs WHERE project_id=? ORDER BY rowid DESC').all(pid) : this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC').all()).map(r => this.decodeRun(r.data as string)); }
    insertRun(r: Run) { assertFlowSnapshot(r);this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(r.id, r.projectId, r.version, JSON.stringify(r)); }
    saveRun(r: Run) { assertFlowSnapshot(r);const old = r.version; r.version++; r.updatedAt = now(); const v = this.db.prepare('UPDATE runs SET version=?,data=? WHERE id=? AND version=?').run(r.version, JSON.stringify(r), r.id, old); if (!v.changes)
        throw new DomainError('STALE_RUN_VERSION', 409); }
    event(projectId: string | null, runId: string | null, type: string, payload: unknown): number { return Number(this.db.prepare('INSERT INTO events(project_id,run_id,type,payload,at)VALUES(?,?,?,?,?)').run(projectId, runId, type, redact(JSON.stringify(payload)), now()).lastInsertRowid); }
    events(pid: string, after = 0, limit = 500): Event[] { return this.db.prepare('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(pid, after, limit).map(r => ({ id: Number(r.id), projectId: r.project_id as string, runId: r.run_id as string | null, type: r.type as string, payload: JSON.parse(r.payload as string), at: r.at as string })); }
    record(kind: string, projectId: string | null, runId: string | null, data: unknown): string { const rid = id('rec'); this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(rid, kind, projectId, runId, redact(JSON.stringify(data)), now()); return rid; }
    records(pid: string, kind?: string) { return (kind ? this.db.prepare('SELECT * FROM records WHERE project_id=? AND kind=? ORDER BY rowid').all(pid, kind) : this.db.prepare('SELECT * FROM records WHERE project_id=? ORDER BY rowid').all(pid)).map(r => ({ id: r.id, kind: r.kind, runId: r.run_id, data: JSON.parse(r.data as string), at: r.at })); }
    approve(pid: string, specHash: string, kind: string, actor = 'LOCAL_OPERATOR') {
        if (kind === 'SPEC') {
            const p = this.project(pid), version = p.specId ? this.planVersion(p.specId) : null;
            if (!version || version.specHash !== specHash || this.spec(version.id).stale) throw new DomainError('SPEC_APPROVAL_STALE', 409);
            this.db.prepare('INSERT OR IGNORE INTO plan_version_approvals VALUES(?,?,?,?)').run(version.id, specHash, actor, now());
        }
        this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(id('approval'), pid, specHash, kind, now());
    }
    approved(pid: string, specHash: string, kind: string): boolean { return !!this.db.prepare('SELECT id FROM approvals WHERE project_id=? AND spec_hash=? AND kind=?').get(pid, specHash, kind); }
    revoke(pid: string) { this.db.prepare('DELETE FROM approvals WHERE project_id=?').run(pid); }
    acquire(pid: string, rid: string) { try {
        this.db.prepare('INSERT INTO workspace_leases VALUES(?,?,?)').run(pid, rid, now());
    }
    catch {
        throw new DomainError('WORKSPACE_BUSY', 409);
    } }
    release(pid: string, rid: string) { this.db.prepare('DELETE FROM workspace_leases WHERE project_id=? AND run_id=?').run(pid, rid); }
    owns(pid: string, rid: string) { return !!this.db.prepare('SELECT 1 FROM workspace_leases WHERE project_id=? AND run_id=?').get(pid, rid); }
    async once<T>(key: string, request: unknown, fn: () => Promise<T>): Promise<T> {
        const digest = hash(request), row = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
        if (row) {
            if (row.request_hash !== digest)
                throw new DomainError('IDEMPOTENCY_KEY_REUSED', 409);
            if (row.status === 'done')
                return JSON.parse(row.response as string);
            throw new DomainError('REQUEST_RESULT_UNCERTAIN', 409, '请求正在执行或上次结果未确定；请刷新核对状态，不要盲目重试收费调用。');
        }
        this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(key, digest, 'pending', null, now());
        try {
            const result = await fn();
            this.db.prepare('UPDATE requests SET status=?,response=? WHERE key=?').run('done', JSON.stringify(result), key);
            return result;
        }
        catch (e) {
            this.db.prepare('UPDATE requests SET status=? WHERE key=?').run('failed', key);
            throw e;
        }
    }
    close() { this.db.close(); }
}
