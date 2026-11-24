/** Public, read-only GitHub/GitLab REST clients.
 * No clones, shell, installs, dynamic hosts, arbitrary redirects or model credentials.
 * A trusted transport may be injected for the existing DM audited egress boundary.
 * Do not inject an unrestricted fetch supplied by a model or remote page. */
import { GuardError, requireCondition as need, text, integer, isRecord, sha256, digest, commitValue } from './common.mjs';
import { createHash } from 'node:crypto';

const ORIGINS = Object.freeze({ github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' });
const WEB = Object.freeze({ github: 'github.com', gitlab: 'gitlab.com' });
const DECODER = new TextDecoder('utf-8', { fatal: true });
const MAX_JSON = 1_800_000;

export function repositoryRef(platform, namespace) {
  need(Object.hasOwn(ORIGINS, platform), 'UNSUPPORTED_SOURCE_PLATFORM', 400);
  text(namespace, 'REPOSITORY', 300);
  const parts = namespace.split('/');
  need((platform !== 'github' || parts.length === 2) && parts.length >= 2 && parts.length <= 8 && parts.every(x => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(x) && x !== '.' && x !== '..' && !x.endsWith('.git')), 'INVALID_REPOSITORY', 400);
  return Object.freeze({ platform, namespace, webUrl: `https://${WEB[platform]}/${namespace}` });
}
export function parseRepositoryUrl(value) {
  text(value, 'REPOSITORY_URL', 1024); let u;
  try { u = new URL(value); } catch { throw new GuardError('INVALID_REPOSITORY_URL', 400); }
  need(u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash, 'UNSAFE_REPOSITORY_URL', 400);
  need(!/%|\\/.test(value), 'ENCODED_REPOSITORY_URL_DENIED', 400);
  const p = Object.keys(WEB).find(x => WEB[x] === u.hostname); need(p, 'UNSUPPORTED_SOURCE_PLATFORM', 400);
  const namespace = u.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
  return repositoryRef(p, namespace);
}
export function repoFilePath(path) {
  text(path, 'REPO_FILE', 512);
  need(!path.startsWith('/') && !/[\\%:#?]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && !p.endsWith('.') && !p.endsWith(' ')), 'UNSAFE_REPO_FILE', 400);
  return path;
}
export function safeSearchKeywords(keywords) {
  need(Array.isArray(keywords) && keywords.length >= 1 && keywords.length <= 8, 'INVALID_KEYWORDS', 400);
  return keywords.map(k => {
    text(k, 'KEYWORD', 60);
    // Coarse leak prevention, not a complete secret classifier. Only preapproved generic terms belong here.
    need(!/[:@\\/\r\n]|\b(?:Bearer|password|token|secret|api_key)\b|\bsk-|gh[pousr]_|-----BEGIN/i.test(k), 'SEARCH_TERM_NOT_PUBLIC_SAFE', 400);
    return k.trim();
  });
}

export class ResearchNetwork {
  #transport; #credentials; #now; #max; #used = 0; #timeout; #cooldowns = new Map();
  constructor({ transport = globalThis.fetch, credentials = {}, maxRequests = 40, timeoutMs = 12000, now = () => Date.now() } = {}) {
    need(typeof transport === 'function', 'MISSING_TRUSTED_TRANSPORT');
    this.#transport = transport; this.#credentials = { ...credentials }; this.#now = now;
    this.#max = integer(maxRequests, 'MAX_REQUESTS', 1, 100); this.#timeout = integer(timeoutMs, 'TIMEOUT', 1, 60000);
    for (const k of Object.keys(this.#credentials)) { need(Object.hasOwn(ORIGINS, k), 'INVALID_CREDENTIAL_SCOPE'); text(this.#credentials[k], 'REPO_CREDENTIAL', 4096); }
  }
  get usedRequests() { return this.#used; }
  async get(platform, path, { signal } = {}) {
    need(Object.hasOwn(ORIGINS, platform), 'UNSUPPORTED_SOURCE_PLATFORM');
    need(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\r\n\\]/.test(path), 'UNSAFE_API_PATH');
    const url = new URL(ORIGINS[platform] + path);
    need(url.origin === new URL(ORIGINS[platform]).origin && (platform !== 'gitlab' || url.pathname.startsWith('/api/v4/')), 'UNSAFE_API_ORIGIN');
    if (signal?.aborted) throw new GuardError('RESEARCH_CANCELLED');
    need((this.#cooldowns.get(platform) ?? 0) <= this.#now(), 'SOURCE_RATE_LIMITED', 429);
    need(this.#used < this.#max, 'RESEARCH_REQUEST_LIMIT', 429); this.#used++;
    const controller = new AbortController(); const signals = signal ? [signal, controller.signal] : [controller.signal];
    const timeout = setTimeout(() => controller.abort(), this.#timeout);
    const headers = { 'Accept': 'application/json', 'User-Agent': 'DreamMaker-Research/0.1' };
    if (platform === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28'; // Still supported; audited in docs.
    if (this.#credentials[platform]) headers.Authorization = `Bearer ${this.#credentials[platform]}`;
    try {
      const response = await this.#transport(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', headers, signal: AbortSignal.any(signals) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GuardError('SOURCE_REDIRECT_REQUIRES_REVIEW', 409); }
      if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        let retry = Number(response.headers.get('retry-after'));
        if (!Number.isFinite(retry) || retry <= 0) retry = 60;
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const until = Math.max(this.#now() + retry * 1000, Number.isFinite(reset) ? reset : 0);
        this.#cooldowns.set(platform, until); await response.body?.cancel(); throw new GuardError('SOURCE_RATE_LIMITED', 429);
      }
      if (!response.ok) { await response.body?.cancel(); throw new GuardError(response.status === 404 ? 'SOURCE_NOT_FOUND' : response.status === 401 ? 'SOURCE_AUTH_FAILED' : response.status === 403 ? 'SOURCE_ACCESS_DENIED' : 'SOURCE_HTTP_FAILED', response.status); }
      if (!/(?:application\/json|\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new GuardError('SOURCE_NOT_JSON',502); }
      const size = Number(response.headers.get('content-length'));
      if (Number.isFinite(size) && size > MAX_JSON) { await response.body?.cancel(); throw new GuardError('SOURCE_RESPONSE_TOO_LARGE',413); }
      need(response.body, 'EMPTY_SOURCE_RESPONSE', 502);
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_JSON) { await reader.cancel(); throw new GuardError('SOURCE_RESPONSE_TOO_LARGE', 413); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks.map(x => Buffer.from(x)));
      let data; try { data = JSON.parse(DECODER.decode(bytes)); } catch { throw new GuardError('SOURCE_INVALID_JSON', 502); }
      return { data, headers: response.headers, retrievedAt: new Date(this.#now()).toISOString() };
    } catch (err) {
      if (err instanceof GuardError) throw err;
      if (typeof err?.code === 'string' && /^(?:RESEARCH|SOURCE)_[A-Z_]{1,90}$/.test(err.code))
        throw new GuardError(err.code, Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 503);
      throw new GuardError(signal?.aborted ? 'RESEARCH_CANCELLED' : controller.signal.aborted ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_UNAVAILABLE', 503);
    } finally { clearTimeout(timeout); }
  }
}

function decodeFile(body, expectedPath, platform, treeEntry) {
  need(isRecord(body) && body.encoding === 'base64' && typeof body.content === 'string', 'SOURCE_FILE_UNREADABLE');
  need(body.type === undefined || body.type === 'file', 'SOURCE_FILE_TYPE_DENIED');
  need(!body.submodule_git_url && !body.target, 'SOURCE_FILE_TYPE_DENIED');
  if (body.file_path !== undefined) need(body.file_path === expectedPath, 'SOURCE_FILE_IDENTITY_MISMATCH');
  if (body.path !== undefined) need(body.path === expectedPath, 'SOURCE_FILE_IDENTITY_MISMATCH');
  const b64 = body.content.replace(/\s/g, '');
  need(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64), 'SOURCE_INVALID_BASE64');
  const bytes = Buffer.from(b64, 'base64'); need(bytes.length <= 240_000 && bytes.toString('base64') === b64, 'SOURCE_FILE_TOO_LARGE');
  if (typeof body.size === 'number') need(body.size === bytes.length, 'SOURCE_FILE_SIZE_MISMATCH');
  const blobId = platform === 'github' ? body.sha : body.blob_id;
  need(typeof blobId === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blobId), 'SOURCE_BLOB_IDENTITY_MISMATCH');
  const actualBlob = createHash(blobId.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  need(blobId === actualBlob && blobId === treeEntry.blobId, 'SOURCE_BLOB_IDENTITY_MISMATCH');
  let content; try { content = DECODER.decode(bytes); } catch { throw new GuardError('SOURCE_FILE_NOT_TEXT'); }
  return { path: expectedPath, content, contentSha256: sha256(bytes), bytes: bytes.length, gitBlobId: blobId, gitMode: treeEntry.mode };
}
function boundedArray(x, max = 20) { need(Array.isArray(x) && x.length <= max, 'SOURCE_INVALID_RESULT'); return x; }

export class PublicRepositoryClient {
  constructor(platform, network = new ResearchNetwork()) { need(Object.hasOwn(ORIGINS, platform), 'UNSUPPORTED_SOURCE_PLATFORM'); this.platform = platform; this.network = network; }
  async search(keywords, { signal, limit = 6 } = {}) {
    keywords = safeSearchKeywords(keywords); integer(limit, 'SEARCH_LIMIT', 1, 12);
    const query = new URLSearchParams(this.platform === 'github'
      ? { q: keywords.join(' ') + ' in:name,description,readme is:public archived:false', per_page: String(limit) }
      : { search: keywords.join(' '), visibility: 'public', simple: 'true', per_page: String(limit) });
    const { data, retrievedAt } = await this.network.get(this.platform, `${this.platform === 'github' ? '/search/repositories' : '/projects'}?${query}`, { signal });
    const rows = this.platform === 'github' ? data.items : data;
    const items = boundedArray(rows, limit).map(row => {
      need(isRecord(row), 'SOURCE_INVALID_RESULT');
      const namespace = this.platform === 'github' ? row.full_name : row.path_with_namespace;
      const ref = repositoryRef(this.platform, namespace);
      need((this.platform !== 'github' || row.private === false) && (this.platform !== 'gitlab' || row.visibility === 'public'), 'SOURCE_NOT_PUBLIC');
      const website = this.platform === 'github' ? row.html_url : row.web_url;
      need(website === ref.webUrl, 'SOURCE_REPOSITORY_IDENTITY_MISMATCH');
      return { ...ref, description: typeof row.description === 'string' ? row.description.slice(0,1000) : '', archived: row.archived === true, sourceId: String(row.id), discoveredAt: retrievedAt, evidenceLevel: 'DISCOVERED_ONLY' };
    });
    return { platform: this.platform, items, retrievedAt, incomplete: this.platform === 'github' ? data.incomplete_results === true : rows.length === limit, scope: 'BOUNDED_PUBLIC_SEARCH_NOT_EXHAUSTIVE' };
  }
  async inspect(ref, { signal, filePaths = ['README.md', 'LICENSE', 'package.json', 'pyproject.toml'] } = {}) {
    need(ref.platform === this.platform, 'SOURCE_PLATFORM_MISMATCH'); ref = repositoryRef(ref.platform, ref.namespace);
    need(Array.isArray(filePaths) && filePaths.length <= 8, 'FILE_INSPECTION_LIMIT'); filePaths = [...new Set(filePaths.map(repoFilePath))];
    const root = this.platform === 'github' ? '/repos/' + ref.namespace : '/projects/' + encodeURIComponent(ref.namespace);
    const metadata = await this.network.get(this.platform, root, { signal }); const m = metadata.data;
    need(isRecord(m), 'SOURCE_INVALID_METADATA');
    need((this.platform === 'github' ? m.html_url : m.web_url) === ref.webUrl, 'SOURCE_REPOSITORY_IDENTITY_MISMATCH');
    need(this.platform === 'github' ? m.private === false : m.visibility === 'public', 'SOURCE_NOT_PUBLIC');
    const branch = text(m.default_branch, 'DEFAULT_BRANCH', 300);
    const commitPath = this.platform === 'github' ? `${root}/commits?per_page=1&sha=${encodeURIComponent(branch)}` : `${root}/repository/commits?per_page=1&ref_name=${encodeURIComponent(branch)}`;
    const commits = await this.network.get(this.platform, commitPath, { signal });
    boundedArray(commits.data, 1); need(commits.data.length === 1, 'SOURCE_NO_COMMIT');
    const commit = commitValue(this.platform === 'github' ? commits.data[0].sha : commits.data[0].id);
    const files = [], failures = [], treeCache = new Map();
    const pinnedEntry = async path => {
      const parent = path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '';
      const key = this.platform === 'github' ? '' : parent;
      if (!treeCache.has(key)) {
        const endpoint = this.platform === 'github' ? `${root}/git/trees/${commit}?recursive=1`
          : `${root}/repository/tree?${new URLSearchParams({ref:commit,path:parent,per_page:'100',page:'1'})}`;
        const result = await this.network.get(this.platform, endpoint, { signal });
        if (this.platform === 'github') {
          need(isRecord(result.data) && result.data.truncated === false && Array.isArray(result.data.tree) && result.data.tree.length <= 20000, 'SOURCE_TREE_INCOMPLETE');
          treeCache.set(key, { entries:result.data.tree, incomplete:false });
        } else {
          treeCache.set(key, { entries:boundedArray(result.data,100), incomplete:!!result.headers.get('x-next-page') });
        }
      }
      const listing = treeCache.get(key), entry = listing.entries.find(e=>e.path === path);
      need(entry, listing.incomplete ? 'SOURCE_TREE_INCOMPLETE' : 'SOURCE_NOT_FOUND');
      need(entry.type === 'blob' && ['100644','100755'].includes(entry.mode), 'SOURCE_FILE_TYPE_DENIED');
      const blobId = this.platform === 'github' ? entry.sha : entry.id;
      need(typeof blobId === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blobId), 'SOURCE_BLOB_IDENTITY_MISMATCH');
      return { mode:entry.mode, blobId };
    };
    for (const path of filePaths) {
      if (signal?.aborted) throw new GuardError('RESEARCH_CANCELLED');
      const endpoint = this.platform === 'github'
        ? `${root}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`
        : `${root}/repository/files/${encodeURIComponent(path)}?ref=${commit}`;
      try {
        const entry = await pinnedEntry(path);
        const result = await this.network.get(this.platform, endpoint, { signal });
        const f = decodeFile(result.data, path, this.platform, entry);
        if (this.platform === 'gitlab') need(result.data.commit_id === commit, 'SOURCE_COMMIT_MISMATCH');
        files.push({ ...f, url: `${ref.webUrl}/${this.platform === 'github' ? 'blob' : '-/blob'}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`, ref: commit, retrievedAt: result.retrievedAt, trust: 'UNTRUSTED_REPOSITORY_DATA' });
      } catch (e) {
        if (e.code === 'RESEARCH_CANCELLED') throw e;
        failures.push({ path, code: e instanceof GuardError ? e.code : 'SOURCE_READ_FAILED' });
        if (e.code === 'SOURCE_RATE_LIMITED' || e.code === 'RESEARCH_REQUEST_LIMIT') break;
      }
    }
    const core = { ...ref, commit, sourceId: String(m.id), discoveredLicenseHint: this.platform === 'github' ? m.license?.spdx_id ?? null : m.license?.key ?? null, archived: m.archived === true, disabled: m.disabled === true, description: typeof m.description === 'string' ? m.description.slice(0,1000) : '', files, failures, retrievedAt: metadata.retrievedAt, evidenceLevel: 'PINNED_TEXT_ONLY_NOT_EXECUTED' };
    return { ...core, snapshotHash: digest(core) };
  }
}
