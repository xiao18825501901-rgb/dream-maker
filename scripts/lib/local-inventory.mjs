import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, parse, relative, sep } from 'node:path';

export function readJson(path) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
}

export function fingerprint(paths) {
    return [...new Set(paths.map(p => resolve(p)))].sort().map(path => {
        try {
            let current = parse(path).root;
            for (const part of relative(current, path).split(sep)) {
                current = resolve(current, part);
                if (lstatSync(current).isSymbolicLink()) return { path, status: 'LINK_DENIED' };
            }
            if (!lstatSync(path).isFile()) return { path, status: 'NOT_A_FILE' };
            const bytes = readFileSync(path);
            return { path, status: 'HASHED', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        } catch (e) {
            return { path, status: e.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE', code: e.code ?? 'UNKNOWN' };
        }
    });
}

export function compare(before, after) {
    const prior = new Map(before.map(item => [item.path, JSON.stringify(item)]));
    const current = new Map(after.map(item => [item.path, JSON.stringify(item)]));
    const changed = [...new Set([...prior.keys(), ...current.keys()])].filter(path => prior.get(path) !== current.get(path)).sort();
    const unverified = [...new Set([...before, ...after].filter(item => item.status !== 'HASHED').map(item => item.path))].sort();
    return { unchanged: changed.length === 0 && unverified.length === 0, changed, unverified };
}
