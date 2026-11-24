#!/usr/bin/env node
// A04: read-only ledger inventory.
//
// This tool never writes to the database it opens, never creates a database, and never invents a
// "zero scope" when a ledger is missing — a missing ledger is reported as MISSING, which is a
// different fact from "spending was zero".
//
// Usage: node scripts/kimi-p1/reconcile-ledger.mjs [path-to-sqlite]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const target = resolve(process.argv[2] ?? '.runtime/dream-maker.sqlite');
if (!existsSync(target)) {
    console.log(JSON.stringify({ ledger: 'MISSING', path: target, note: '缺账本不等于零消费；不要据此新建零 scope。' }, null, 1));
    process.exit(0);
}

let db;
try {
    db = new DatabaseSync(target, { readOnly: true });
} catch (error) {
    console.log(JSON.stringify({ ledger: 'UNREADABLE', path: target, reason: String(error.message ?? error).slice(0, 160) }, null, 1));
    process.exit(0);
}

const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map(r => r.name);
const counts = {};
for (const table of tables) {
    try { counts[table] = db.prepare('select count(*) as n from "' + table + '"').get().n; }
    catch { counts[table] = 'ERROR'; }
}

const interested = tables.filter(t => /UsageLedger|NativeProbe|ModelAttempt|Budget|Approval/i.test(t));
const detail = {};
for (const table of interested) {
    try { detail[table] = db.prepare('select * from "' + table + '" limit 20').all(); }
    catch (error) { detail[table] = { error: String(error.message ?? error).slice(0, 120) }; }
}

console.log(JSON.stringify({
    ledger: 'PRESENT',
    path: target,
    tables: counts,
    // A ledger row with costUsd === null means "unknown cost", which must never be read as free.
    unknownCostRows: interested
        .filter(t => t === 'UsageLedger' || t === 'NativeProbeReceipt')
        .map(t => {
            try { return { table: t, rows: db.prepare('select count(*) as n from "' + t + '" where costUsd is null').get().n }; }
            catch { return { table: t, rows: 'N/A' }; }
        }),
    detail
}, null, 1));
db.close();
