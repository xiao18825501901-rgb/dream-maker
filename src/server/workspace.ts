import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { hash, within, DomainError, hasSecret } from './security.js';
export function files(root: string): {
    path: string;
    bytes: number;
    sha256: string;
}[] {
    const result: {
        path: string;
        bytes: number;
        sha256: string;
    }[] = [];
    let total = 0;
    if (!existsSync(root))
        return result;
    function visit(dir: string) {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (['node_modules', '.git'].includes(e.name.toLowerCase()))
                continue;
            const path = resolve(dir, e.name);
            if (e.isSymbolicLink())
                throw new DomainError('WORKSPACE_SYMLINK_DENIED', 409);
            const st = lstatSync(path);
            if (st.isDirectory())
                visit(path);
            else if (st.isFile()) {
                total += st.size;
                if (st.size > 2000000 || total > 20000000 || result.length >= 2000)
                    throw new DomainError('WORKSPACE_LIMIT', 413);
                const name = relative(root, path).replaceAll('\\', '/');
                if (/^\.env(?:\.|$)/i.test(e.name) || /^(auth\.json|credentials\.json)$/i.test(e.name))
                    throw new DomainError('SENSITIVE_ARTIFACT_DENIED', 403);
                const content = readFileSync(path);
                if (hasSecret(content.toString('utf8')))
                    throw new DomainError('SECRET_IN_ARTIFACT', 403);
                result.push({ path: name, bytes: st.size, sha256: hash(content) });
            }
            else
                throw new DomainError('SPECIAL_FILE_DENIED', 403);
        }
    }
    visit(root);
    return result;
}
export function treeHash(root: string) { return hash(files(root)); }
export function put(root: string, name: string, content: string) { const path = within(root, name); mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode: 0o600 }); }
export function get(root: string, name: string) {
    const path = within(root, name);
    if (name.split('/').some(x => ['.git', 'node_modules', 'auth.json', 'credentials.json'].includes(x.toLowerCase()) || /^\.env(?:\.|$)/i.test(x)))
        throw new DomainError('SENSITIVE_ARTIFACT_DENIED', 403);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 2000000)
        throw new DomainError('ARTIFACT_READ_LIMIT', 413);
    const bytes = readFileSync(path);
    if (hasSecret(bytes.toString('utf8')))
        throw new DomainError('SECRET_IN_ARTIFACT', 403);
    return bytes;
}
// A no-compression ZIP writer keeps the runtime dependency-free. CRC and sizes are real.
function crc32(b: Buffer) { let crc = 0xffffffff; for (const byte of b) {
    crc ^= byte;
    for (let k = 0; k < 8; k++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
} return (crc ^ 0xffffffff) >>> 0; }
export function zip(entries: {
    path: string;
    data: Buffer;
}[]): Buffer {
    const body: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    const names = new Set<string>();
    if (entries.length > 65535)
        throw new DomainError('ZIP_ENTRY_LIMIT');
    for (const e of entries) {
        if (!e.path || e.path.startsWith('/') || e.path.includes('\\') || e.path.split('/').includes('..'))
            throw new DomainError('ZIP_PATH_DENIED');
        if (names.has(e.path) || e.path.includes(':') || e.path.includes('\0'))
            throw new DomainError('ZIP_DUPLICATE_OR_UNSAFE_PATH');
        names.add(e.path);
        const name = Buffer.from(e.path), crc = crc32(e.data), local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(e.data.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        body.push(local, name, e.data);
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(0x800, 8);
        h.writeUInt32LE(crc, 16);
        h.writeUInt32LE(e.data.length, 20);
        h.writeUInt32LE(e.data.length, 24);
        h.writeUInt16LE(name.length, 28);
        h.writeUInt32LE(offset, 42);
        central.push(h, name);
        offset += local.length + name.length + e.data.length;
    }
    const index = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(index.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...body, index, end]);
}
