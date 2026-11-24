import { createHash } from 'node:crypto';

export interface ZipEntry { path: string; data: Buffer; size: number; crcOk: boolean }
export interface ArtifactCheck { label: string; ok: boolean; detail: string }
export interface ArtifactRunBinding { id: string; specHash: string; treeHash: string }

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Read a stored (uncompressed) ZIP written by the product's own writer in workspace.ts.
 *
 * A delivered archive has to be verified without a decompression dependency and without trusting the
 * extractor, so the central directory is walked here and every entry's CRC is recomputed. A method other
 * than stored is refused rather than guessed at: the product never writes one, so seeing one means the
 * archive did not come from this exporter.
 */
export function readStoredZip(bytes: Buffer): ZipEntry[] {
    const eocd = bytes.length - 22;
    if (eocd < 0 || bytes.readUInt32LE(eocd) !== 0x06054b50) throw new Error('ZIP_EOCD_MISSING');
    const count = bytes.readUInt16LE(eocd + 10), cdOffset = bytes.readUInt32LE(eocd + 16);
    const entries: ZipEntry[] = [];
    let at = cdOffset;
    for (let i = 0; i < count; i += 1) {
        if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('ZIP_CENTRAL_HEADER_INVALID');
        const method = bytes.readUInt16LE(at + 10);
        if (method !== 0) throw new Error('ZIP_COMPRESSED_ENTRY_UNSUPPORTED:' + method);
        const crc = bytes.readUInt32LE(at + 16), size = bytes.readUInt32LE(at + 20);
        const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
        const localOffset = bytes.readUInt32LE(at + 42);
        const path = bytes.toString('utf8', at + 46, at + 46 + nameLength);
        if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP_LOCAL_HEADER_INVALID:' + path);
        const localName = bytes.readUInt16LE(localOffset + 26), localExtra = bytes.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localName + localExtra;
        const data = bytes.subarray(start, start + size);
        entries.push({ path, data, size, crcOk: crc32(data) === crc });
        at += 46 + nameLength + extra + comment;
    }
    return entries;
}

/**
 * Verify an exported delivery archive against the run it claims to be.
 *
 * The manifest travels inside the archive, so the checks have to be structural: every entry's CRC holds, the
 * manifest binds this run, every file and document it lists is present with the bytes it claims, and nothing
 * rides along that the manifest does not describe. The workspace comparison is the caller's job because it
 * needs the filesystem.
 */
export function verifyArtifactArchive(bytes: Buffer, run: ArtifactRunBinding): { ok: boolean; checks: ArtifactCheck[] } {
    const checks: ArtifactCheck[] = [];
    const check = (label: string, ok: boolean, detail: string) => { checks.push({ label, ok, detail }); return ok; };
    let entries: ZipEntry[];
    try { entries = readStoredZip(bytes); } catch (error) { check('archive parses as a stored ZIP', false, String((error as Error).message)); return { ok: false, checks }; }
    check('archive parses as a stored ZIP', true, entries.length + ' entries');
    check('every entry CRC matches its payload', entries.every(entry => entry.crcOk), entries.length + ' entries');
    const manifestEntry = entries.find(entry => entry.path === 'DREAM_MAKER_MANIFEST.json');
    if (!check('archive carries DREAM_MAKER_MANIFEST.json', !!manifestEntry, manifestEntry ? 'present' : entries.map(entry => entry.path).join(', '))) return { ok: false, checks };
    let manifest: { runId?: string; specHash?: string; treeHash?: string; files?: { path: string; bytes: number; sha256: string }[]; documents?: { path: string; bytes: number; sha256: string }[] };
    try { manifest = JSON.parse(manifestEntry!.data.toString('utf8')); } catch { check('manifest is valid JSON', false, 'unparsable'); return { ok: false, checks }; }
    check('manifest is valid JSON', true, 'schema=' + String((manifest as { schema?: string }).schema ?? '-'));
    check('manifest binds this run', manifest.runId === run.id && manifest.specHash === run.specHash, 'runId=' + String(manifest.runId));
    check('manifest binds the delivered tree', manifest.treeHash === run.treeHash, String(manifest.treeHash ?? '').slice(0, 16) + '…');
    const compare = (label: string, list: { path: string; bytes: number; sha256: string }[] | undefined) => {
        const wanted = list ?? [];
        let ok = 0;
        const misses: string[] = [];
        for (const item of wanted) {
            const entry = entries.find(candidate => candidate.path === item.path);
            const digest = entry ? sha256(entry.data) : null;
            if (entry && entry.data.length === item.bytes && digest === item.sha256) ok += 1;
            else misses.push(item.path + ' expected=' + String(item.sha256).slice(0, 12) + '… actual=' + String(digest).slice(0, 12) + '…');
        }
        return check(label, ok === wanted.length, ok + '/' + wanted.length + (misses.length ? ' :: ' + misses.join('; ') : ''));
    };
    compare('every manifest file is in the archive with its bytes', manifest.files);
    compare('every manifest document is in the archive with its bytes', manifest.documents);
    const described = new Set([...(manifest.files ?? []).map(item => item.path), ...(manifest.documents ?? []).map(item => item.path), 'DREAM_MAKER_MANIFEST.json']);
    const strays = entries.filter(entry => !described.has(entry.path)).map(entry => entry.path);
    check('archive holds nothing the manifest does not describe', strays.length === 0, strays.length ? strays.join(', ') : 'no strays');
    return { ok: checks.every(item => item.ok), checks };
}
