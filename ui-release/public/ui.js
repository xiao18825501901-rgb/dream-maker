import { escapeHtml as e, UiError, semanticPayload } from './contracts.js';
import { patchHtml, DraftStore, downloadBlob } from './dom.js';
import { shell, gateContent, roles } from './views.js';
const writes = new Set(['next', 'skip', 'finish', 'continue', 'approve', 'pause', 'resume', 'cancel', 'confirm-cancel', 'accept', 'confirm-accept', 'demo-step', 'models', 'laya-probe']);
/** Shared controller for local and public builds. The injected adapter is selected by the entry file only. */
export class DreamMakerUI {
    adapter;
    app;
    dialog;
    drafts;
    epoch = 0;
    listSeq = 0;
    readSeq = 0;
    pendingRefresh = false;
    stopStream = null;
    refreshTimer = null;
    toastTimer = null;
    modalCleanup = null;
    composing = false;
    gateDismissed = false;
    modalKind = '';
    modalReturn = null;
    life = new AbortController();
    disposed = false;
    v;
    constructor(adapter) {
        this.adapter = adapter;
        this.app = document.getElementById('app');
        this.drafts = new DraftStore('dream-maker.ui-drafts.v2.' + adapter.mode);
        this.v = { mode: adapter.mode, screen: 'home', projects: [], snapshot: null, settings: null, tab: 'work', busy: false, error: '', events: [], connection: 'closed', railClosed: false, fileName: '', fileText: '', files: [], previewUrl: '', previewScope: '', diagnostics: '', specSearch: '', logLimit: 40, draft: key => this.drafts.get(key), hasDraft: key => this.drafts.has(key) };
        this.dialog = document.createElement('dialog');
        this.dialog.id = 'dm-dialog';
        this.dialog.className = 'dialog t-modal';
        this.dialog.setAttribute('aria-labelledby', 'dialog-title');
        document.body.append(this.dialog);
        const opts = { signal: this.life.signal };
        document.addEventListener('click', ev => { if (this.owned(ev.target))
            this.click(ev); }, opts);
        document.addEventListener('submit', ev => { if (this.owned(ev.target))
            this.submit(ev); }, opts);
        document.addEventListener('input', ev => { if (this.owned(ev.target))
            this.input(ev); }, opts);
        document.addEventListener('change', ev => { if (this.owned(ev.target))
            this.change(ev); }, opts);
        document.addEventListener('compositionstart', ev => { if (this.owned(ev.target))
            this.composing = true; }, opts);
        document.addEventListener('compositionend', ev => { if (this.owned(ev.target)) {
            this.composing = false;
            this.input(ev);
        } }, opts);
        document.addEventListener('keydown', ev => this.key(ev), opts);
        window.addEventListener('popstate', () => { void this.routeFromUrl().catch(err => { this.v.error = this.errorText(err); this.render(); }); }, opts);
        window.addEventListener('pagehide', ev => { if (ev.persisted)
            this.disconnect();
        else
            this.dispose(); }, opts);
        window.addEventListener('pageshow', ev => { if (ev.persisted)
            void this.routeFromUrl().catch(err => { this.v.error = this.errorText(err); this.render(); }); }, opts);
        this.dialog.addEventListener('cancel', ev => { ev.preventDefault(); if (this.modalKind === 'gate')
            this.gateDismissed = true; this.closeDialog(); }, opts);
    }
    owned(target) { return target instanceof Node && (this.app.contains(target) || this.dialog.contains(target)); }
    async boot() {
        try {
            await this.adapter.init();
            this.v.settings = await this.adapter.request('/config');
            await this.list();
            await this.routeFromUrl();
            this.render();
        }
        catch (err) {
            this.v.error = this.errorText(err);
            this.render();
            if (this.adapter.mode === 'local')
                this.showDialog('login', `<span class="eyebrow">LOCAL SESSION</span><h2 id="dialog-title">请从本机启动终端进入。</h2><p>使用终端显示的一次性登录链接。链接失效或服务重启时，请重新获取；不要把它分享给别人。</p><p class="notice warning">${e(this.v.error)}</p><button type="button" data-action="close-modal">关闭说明</button>`);
        }
    }
    errorText(err) { return err instanceof UiError ? `${err.code} · ${err.message}` : err instanceof Error ? err.message : '操作未完成，请刷新状态核对。'; }
    async list() { const seq = ++this.listSeq; const data = await this.adapter.request('/projects'); if (seq === this.listSeq)
        this.v.projects = data.projects; }
    url() { try {
        const q = new URLSearchParams();
        if (this.v.screen === 'project' && this.v.snapshot) {
            q.set('project', this.v.snapshot.project.id);
            q.set('tab', this.v.tab);
        }
        else if (this.v.screen === 'settings')
            q.set('view', 'settings');
        history.replaceState(null, '', '/' + (q.size ? '?' + q.toString() : ''));
    }
    catch { /* about:blank fixture has no origin; never used as network verification. */ } }
    async routeFromUrl() { const query = new URLSearchParams(location.search), pid = query.get('project'); if (pid) {
        await this.open(pid);
        const tab = query.get('tab');
        if (['work', 'answers', 'spec', 'logs', 'files'].includes(tab || '')) {
            this.v.tab = tab;
            if (tab === 'files')
                await this.loadFiles();
            this.url();
            this.render();
        }
    }
    else if (query.get('view') === 'settings')
        await this.settings();
    else
        this.home(); }
    disconnect() { this.stopStream?.(); this.stopStream = null; if (this.refreshTimer)
        clearTimeout(this.refreshTimer); this.refreshTimer = null; this.readSeq++; }
    focusPage() { if (!this.dialog.open) {
        this.app.querySelector('#main-content')?.focus({ preventScroll: true });
        window.scrollTo(0, 0);
    } }
    home() { this.epoch++; this.disconnect(); this.closeDialog(); this.v.screen = 'home'; this.v.error = ''; this.url(); this.render(); this.focusPage(); }
    async settings() { const token = ++this.epoch; this.disconnect(); this.closeDialog(); const settings = await this.adapter.request('/config'); if (token !== this.epoch)
        return; this.v.settings = settings; this.v.screen = 'settings'; this.v.error = ''; this.url(); this.render(); this.focusPage(); }
    async open(pid) {
        const token = ++this.epoch;
        this.disconnect();
        this.closeDialog();
        const s = await this.adapter.request('/projects/' + encodeURIComponent(pid));
        if (token !== this.epoch)
            return;
        this.v.snapshot = s;
        this.v.screen = 'project';
        this.v.tab = 'work';
        this.v.events = [];
        this.v.error = '';
        this.v.fileName = '';
        this.v.fileText = '';
        this.v.files = [];
        this.v.previewUrl = '';
        this.v.specSearch = '';
        this.gateDismissed = false;
        this.url();
        this.stopStream = this.adapter.subscribe(pid, event => {
            if (token !== this.epoch || this.v.snapshot?.project.id !== pid)
                return;
            if (this.v.events.some(x => x.id === event.id))
                return;
            this.v.events.push(event);
            this.v.events = this.v.events.slice(-300);
            if (!this.refreshTimer)
                this.refreshTimer = setTimeout(() => { this.refreshTimer = null; if (!this.v.busy)
                    void this.refreshSnapshot(pid, token);
                else
                    this.pendingRefresh = true; }, 120);
            if (this.v.tab === 'logs')
                this.render();
        }, state => { if (token === this.epoch) {
            this.v.connection = state;
            this.render();
        } });
        this.render();
        this.focusPage();
    }
    async refreshSnapshot(pid, token = this.epoch) {
        const seq = ++this.readSeq;
        try {
            const s = await this.adapter.request('/projects/' + encodeURIComponent(pid));
            if (token !== this.epoch || seq !== this.readSeq || this.v.snapshot?.project.id !== pid || this.v.busy)
                return;
            if (s.project.version < this.v.snapshot.project.version)
                return;
            this.v.snapshot = s;
            this.v.error = '';
            this.render();
        }
        catch (err) {
            if (token === this.epoch) {
                this.v.error = this.errorText(err);
                this.render();
            }
        }
    }
    async mutate(action, body = {}, pid = this.v.snapshot?.project.id) {
        if (!pid)
            throw new UiError('NO_PROJECT', '请先选择项目。');
        const token = this.epoch;
        this.readSeq++;
        const s = await this.adapter.request('/projects/' + encodeURIComponent(pid) + '/' + action, 'POST', body);
        this.readSeq++;
        if (token === this.epoch && this.v.snapshot?.project.id === pid)
            this.v.snapshot = s;
        await this.list();
        return s;
    }
    async nextIfNeeded(s) { if (s.project.state === 'INTERVIEWING' && !s.project.questions.some(q => !s.project.answers.some(a => a.questionId === q.id)))
        return this.mutate('next', {}, s.project.id); return s; }
    async control(action, body = {}) { const r = this.v.snapshot?.runs[0]; if (!r)
        return; const token = this.epoch; this.readSeq++; const s = await this.adapter.request('/runs/' + encodeURIComponent(r.id) + '/' + action, 'POST', body); this.readSeq++; if (token === this.epoch && this.v.snapshot?.project.id === r.projectId)
        this.v.snapshot = s; }
    async act(work) { if (this.v.busy)
        return; const token = this.epoch; this.v.busy = true; this.v.error = ''; this.render(); try {
        await work();
    }
    catch (err) {
        if (token === this.epoch) {
            this.v.error = this.errorText(err);
            const alert = this.dialog.querySelector('#dialog-error');
            if (alert)
                alert.textContent = this.v.error;
        }
        else
            this.toast('先前页面的操作未完成，请返回该项目核对。');
    }
    finally {
        this.v.busy = false;
        this.render();
        if (this.pendingRefresh && this.v.screen === 'project' && this.v.snapshot) {
            this.pendingRefresh = false;
            void this.refreshSnapshot(this.v.snapshot.project.id);
        }
    } }
    render() {
        if (this.disposed)
            return;
        // Reconciliation preserves control nodes instead of replacing the application tree on SSE.
        patchHtml(this.app, shell(this.v));
        this.app.setAttribute('aria-busy', String(this.v.busy));
        for (const b of [...this.app.querySelectorAll('button'), ...this.dialog.querySelectorAll('button')])
            if (b.type === 'submit' || writes.has(b.dataset.action || ''))
                b.disabled = this.v.busy;
        if (this.v.busy)
            for (const control of [...this.app.querySelectorAll('form input,form select,form textarea'), ...this.dialog.querySelectorAll('form input,form select,form textarea')])
                control.disabled = true;
        if (this.v.screen === 'project' && this.v.tab === 'work' && this.v.snapshot?.project.state === 'AWAITING_INTERVIEW_DECISION' && !this.gateDismissed && !this.dialog.open)
            this.showDialog('gate', gateContent(this.v));
    }
    toast(message) { const t = document.getElementById('toast'); if (!t)
        return; if (this.toastTimer)
        clearTimeout(this.toastTimer); t.textContent = message; t.hidden = false; this.toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }
    showDialog(kind, content) {
        if (this.modalCleanup)
            clearTimeout(this.modalCleanup);
        this.modalCleanup = null;
        this.modalReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.modalKind = kind;
        this.dialog.classList.remove('is-closing', 'is-open');
        this.dialog.innerHTML = `<div class="dialog-surface">${content}<p id="dialog-error" class="dialog-error" role="alert"></p></div>`;
        if (!this.dialog.open)
            this.dialog.showModal();
        this.dialog.querySelector('textarea,input:not([type=hidden]),button,a')?.focus();
        if (this.dialog.querySelector('#dialog-description'))
            this.dialog.setAttribute('aria-describedby', 'dialog-description');
        else
            this.dialog.removeAttribute('aria-describedby');
        requestAnimationFrame(() => { if (this.dialog.open)
            this.dialog.classList.add('is-open'); });
    }
    closeDialog() {
        if (!this.dialog.open)
            return;
        this.dialog.classList.remove('is-open');
        this.dialog.classList.add('is-closing');
        this.dialog.close();
        this.modalKind = '';
        const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')) || 150;
        this.modalCleanup = setTimeout(() => { this.dialog.classList.remove('is-closing'); this.modalCleanup = null; }, ms);
        const back = this.modalReturn?.isConnected ? this.modalReturn : this.app.querySelector('[role=tab][aria-selected=true]') || this.app.querySelector('#main-content');
        back?.focus({ preventScroll: true });
        this.modalReturn = null;
    }
    input(ev) {
        const t = ev.target;
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement))
            return;
        if (t.dataset.draft)
            this.drafts.set(t.dataset.draft, t.value);
        if (t.name === 'specSearch' && !this.composing) {
            this.v.specSearch = t.value;
            this.render();
        }
    }
    change(ev) { const t = ev.target; if (t instanceof HTMLSelectElement && t.name === 'scenario' && t.value && this.adapter.selectScenario) {
        const state = t.value;
        t.value = '';
        void this.act(async () => { const pid = this.v.snapshot.project.id, token = this.epoch, s = await this.adapter.selectScenario(pid, state); if (token === this.epoch)
            this.v.snapshot = s; });
    } }
    field(form, name) { return String(new FormData(form).get(name) ?? ''); }
    submit(ev) {
        ev.preventDefault();
        if (this.composing || this.v.busy)
            return;
        const f = ev.target;
        if (f.id === 'new-project') {
            const body = { name: this.field(f, 'projectName').trim(), idea: this.field(f, 'idea').trim(), mode: this.field(f, 'mode'), apiConsent: new FormData(f).has('apiConsent') };
            const token = this.epoch;
            void this.act(async () => { let s = await this.adapter.request('/projects', 'POST', body); this.drafts.delete('projectName'); this.drafts.delete('idea'); await this.list(); if (token !== this.epoch)
                return; await this.open(s.project.id); s = await this.nextIfNeeded(this.v.snapshot); if (this.v.snapshot?.project.id === s.project.id)
                this.v.snapshot = s; });
        }
        else if (f.id === 'answer-form') {
            const p = this.v.snapshot.project, q = p.questions.find(q => !p.answers.some(a => a.questionId === q.id));
            if (!q)
                return;
            const text = this.field(f, 'answer');
            void this.act(async () => { let s = await this.mutate('answer', { questionId: q.id, text, version: p.version }, p.id); this.drafts.delete('answer:' + p.id + ':' + q.id); this.gateDismissed = false; await this.nextIfNeeded(s); });
        }
        else if (f.id === 'edit-answer-form') {
            const p = this.v.snapshot.project, qid = this.field(f, 'questionId'), text = this.field(f, 'editedAnswer'), token = this.epoch;
            void this.act(async () => { await this.mutate('answer', { questionId: qid, text, version: p.version }, p.id); this.drafts.delete('edit:' + p.id + ':' + qid); if (token !== this.epoch)
                return; this.gateDismissed = true; this.v.tab = 'answers'; this.closeDialog(); this.toast('回答已修改；旧规格与确认需要重新核对。'); });
        }
        else if (f.id === 'semantics-form' && this.adapter.mode === 'local' && this.v.snapshot?.spec) {
            const pid = this.v.snapshot.project.id, token = this.epoch;
            const body = semanticPayload(this.v.snapshot.spec, name => this.field(f, name), new FormData(f).has('semanticConsent'));
            void this.act(async () => { await this.mutate('semantics', body, pid); if (token === this.epoch)
                this.toast('已保存分类与验收；新规格需要重新确认。'); });
        }
        else if (f.id === 'spec-notes') {
            const pid = this.v.snapshot.project.id, notes = this.field(f, 'notes');
            void this.act(async () => { await this.mutate('finish', { notes, summarize: false }, pid); this.drafts.delete('notes:' + pid); this.toast('已生成新规格；旧确认失效。'); });
        }
        else if (f.id === 'build-form') {
            const body = { specHash: this.v.snapshot.spec.hash, approved: new FormData(f).has('buildConsent'), demoFault: new FormData(f).has('demoFault') }, token = this.epoch;
            void this.act(async () => { await this.mutate('build', body); if (token !== this.epoch)
                return; this.v.tab = 'work'; this.url(); });
        }
        else if (f.id === 'settings-form') {
            const roles = Object.fromEntries(['planner1', 'planner2', 'executor', 'reviewer'].map(r => [r, this.field(f, 'laya_' + r)]));
            const body = { planner1: { protocol: this.field(f, 'protocol'), model: this.field(f, 'p1Model') }, codexModel: this.field(f, 'codexModel'), laya: { mode: this.field(f, 'layaMode'), roles }, limits: { maxRepairs: Number(this.field(f, 'maxRepairs')), maxCalls: Number(this.field(f, 'maxCalls')), maxSeconds: Number(this.field(f, 'maxSeconds')), stepTimeoutMs: Number(this.field(f, 'stepTimeoutMs')) } };
            void this.act(async () => { this.v.settings = await this.adapter.request('/config', 'PUT', body); this.toast('设置已保存；没有自动发起收费连接测试。'); });
        }
    }
    async loadFiles() { const r = this.v.snapshot?.runs[0]; if (!r)
        return; const token = this.epoch; const data = await this.adapter.request('/runs/' + encodeURIComponent(r.id) + '/files'); if (token === this.epoch && this.v.snapshot?.runs[0]?.id === r.id) {
        this.v.files = data.files;
        this.render();
    } }
    async copy(text) { try {
        await navigator.clipboard.writeText(text);
        this.toast('已复制。');
    }
    catch {
        this.toast('浏览器不允许自动复制，请在文本区选择后手动复制。');
    } }
    click(ev) {
        const b = ev.target?.closest('[data-action]');
        if (!b || !this.owned(b))
            return;
        if (b instanceof HTMLAnchorElement && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0))
            return;
        ev.preventDefault();
        const action = b.dataset.action;
        if ((writes.has(action) || action === 'scenario') && this.v.busy)
            return;
        if (action === 'home') {
            this.home();
            return;
        }
        if (action === 'new') {
            this.home();
            this.app.querySelector('#project-name')?.focus();
            return;
        }
        if (action === 'settings') {
            const task = this.settings(), token = this.epoch;
            void task.catch(err => { if (token === this.epoch) {
                this.v.error = this.errorText(err);
                this.render();
            } });
            return;
        }
        if (action === 'open') {
            const task = this.open(b.dataset.id), token = this.epoch;
            void task.catch(err => { if (token === this.epoch) {
                this.v.error = this.errorText(err);
                this.render();
            } });
            return;
        }
        if (action === 'tab') {
            this.v.tab = b.dataset.tab;
            this.gateDismissed = true;
            this.closeDialog();
            this.url();
            this.render();
            if (this.v.tab === 'files')
                void this.act(() => this.loadFiles());
            return;
        }
        if (action === 'rail') {
            this.v.railClosed = !this.v.railClosed;
            this.render();
            return;
        }
        if (action === 'team') {
            this.showDialog('team', `<h2 id="dialog-title">四角色与运行边界</h2>${roles(this.v)}<button type="button" data-action="close-modal">返回工作区</button>`);
            return;
        }
        if (action === 'menu') {
            this.showDialog('menu', `<h2 id="dialog-title">项目导航</h2><nav class="drawer-nav"><button type="button" data-action="home">灵感工坊</button><button type="button" data-action="settings">连接与设置</button>${this.v.projects.map(p => `<a href="/?project=${encodeURIComponent(p.id)}" data-action="open" data-id="${e(p.id)}">${e(p.name)}</a>`).join('')}</nav><button type="button" data-action="close-modal">关闭导航</button>`);
            return;
        }
        if (action === 'local-help') {
            this.showDialog('help', '<span class="eyebrow">LOCAL EDITION</span><h2 id="dialog-title">UI 上线，不等于 Agent 上线。</h2><p>本地集成版由你电脑上的 Dream Maker 同源服务托管，保留原有认证、权限与预算。</p><p>将本轮 UI 增量交给掌握最新工作树的 Codex 合并，再在项目目录运行：</p><pre>node scripts/ui-upgrade/build-ui.mjs\nnode dist/server/main.js</pre><p>公开演示不连接本机、不接收密钥，也不会扫描端口。真实 Codex、DSH、Laya 联调需本机独立验收。</p><button type="button" class="primary" data-action="close-modal">知道了</button>');
            return;
        }
        if (action === 'close-modal') {
            if (this.modalKind === 'gate')
                this.gateDismissed = true;
            this.closeDialog();
            return;
        }
        if (action === 'show-gate') {
            this.gateDismissed = false;
            this.showDialog('gate', gateContent(this.v));
            return;
        }
        if (action === 'review-answers') {
            this.gateDismissed = true;
            this.v.tab = 'answers';
            this.closeDialog();
            this.url();
            this.render();
            return;
        }
        if (action === 'edit-answer') {
            const p = this.v.snapshot.project, q = p.questions.find(q => q.id === b.dataset.id), a = p.answers.find(a => a.questionId === q.id);
            const draftKey = 'edit:' + p.id + ':' + q.id;
            this.showDialog('edit', `<h2 id="dialog-title">修改原始回答</h2><p>${e(q.text)}</p><form id="edit-answer-form"><input name="questionId" type="hidden" value="${e(q.id)}"><label for="edited-answer">你的回答</label><textarea id="edited-answer" name="editedAnswer" data-draft="${e(draftKey)}" rows="5" maxlength="8000" required>${e(this.drafts.has(draftKey) ? this.drafts.get(draftKey) : a.text)}</textarea><p class="hint">保存后旧规格、相关审批需要重新核对。</p><div class="actions"><button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">保存修改</button></div></form>`);
            return;
        }
        if (action === 'cancel') {
            this.showDialog('cancel', '<h2 id="dialog-title">取消这次运行？</h2><p>已保存的需求与证据保留。取消请求不等于进程已经停止；等待服务端确认清理结果。</p><div class="actions"><button type="button" data-action="close-modal">保留运行</button><button type="button" class="danger-outline" data-action="confirm-cancel">确认取消运行</button></div>');
            return;
        }
        if (action === 'accept') {
            this.showDialog('accept', `<h2 id="dialog-title">接受当前成果？</h2><p>${this.adapter.mode === 'public-demo' ? '接受的是固定 UI 演示成果，不是生成项目或真实测试结论。' : '请先核对文件与当前版本的验证结果。本按钮不替代业务验收。'}</p><div class="actions"><button type="button" data-action="close-modal">继续检查</button><button type="button" class="primary" data-action="confirm-accept">确认接受</button></div>`);
            return;
        }
        if (action === 'copy-prompt') {
            void this.copy(this.v.snapshot?.spec?.masterPrompt || '');
            return;
        }
        if (action === 'copy-file') {
            void this.copy(this.v.fileText);
            return;
        }
        if (action === 'more-logs') {
            this.v.logLimit += 40;
            this.render();
            return;
        }
        if (action === 'latest') {
            const log = this.app.querySelector('#event-log');
            if (log)
                log.scrollTop = log.scrollHeight;
            return;
        }
        void this.act(async () => {
            if (action === 'refresh') {
                await this.list();
                if (this.v.snapshot && this.v.screen === 'project') {
                    const pid = this.v.snapshot.project.id, token = this.epoch, s = await this.adapter.request('/projects/' + encodeURIComponent(pid));
                    if (token === this.epoch)
                        this.v.snapshot = s;
                }
                else
                    this.v.settings = await this.adapter.request('/config');
            }
            else if (action === 'next') {
                const s = await this.mutate('next');
                this.v.snapshot?.project.id === s.project.id && (this.v.snapshot = s);
            }
            else if (action === 'skip') {
                const p = this.v.snapshot.project, q = p.questions.find(q => !p.answers.some(a => a.questionId === q.id));
                let s = await this.mutate('answer', { questionId: q.id, text: '', skip: true, version: p.version });
                this.drafts.delete('answer:' + p.id + ':' + q.id);
                await this.nextIfNeeded(s);
            }
            else if (action === 'continue') {
                const token = this.epoch;
                this.closeDialog();
                this.gateDismissed = false;
                const s = await this.mutate('continue');
                await this.nextIfNeeded(s);
                if (token === this.epoch) {
                    this.v.tab = 'work';
                    this.url();
                }
            }
            else if (action === 'finish') {
                const pid = this.v.snapshot.project.id, token = this.epoch;
                this.closeDialog();
                await this.mutate('finish', { notes: this.drafts.get('notes:' + pid) }, pid);
                if (token !== this.epoch)
                    return;
                this.v.tab = 'spec';
                this.gateDismissed = true;
                this.url();
            }
            else if (action === 'approve')
                await this.mutate('approve', { specHash: this.v.snapshot.spec.hash });
            else if (action === 'pause' || action === 'resume')
                await this.control(action);
            else if (action === 'confirm-cancel') {
                await this.control('cancel');
                this.closeDialog();
            }
            else if (action === 'confirm-accept') {
                await this.control('accept');
                this.closeDialog();
            }
            else if (action === 'demo-step' && this.adapter.advanceScenario) {
                const pid = this.v.snapshot.project.id, token = this.epoch, s = await this.adapter.advanceScenario(pid);
                if (token === this.epoch)
                    this.v.snapshot = s;
            }
            else if (action === 'files-refresh')
                await this.loadFiles();
            else if (action === 'file') {
                const r = this.v.snapshot.runs[0], token = this.epoch, data = await this.adapter.request('/runs/' + encodeURIComponent(r.id) + '/files?path=' + encodeURIComponent(b.dataset.path));
                if (token === this.epoch) {
                    this.v.fileName = data.path;
                    this.v.fileText = data.content;
                }
            }
            else if (action === 'preview') {
                const r = this.v.snapshot.runs[0], token = this.epoch, data = await this.adapter.request('/runs/' + encodeURIComponent(r.id) + '/preview');
                if (token !== this.epoch)
                    return;
                if (this.adapter.mode === 'public-demo') {
                    if (data.scope !== 'UI_DEMO_FIXED_SAMPLE' || data.url !== './sample.html')
                        throw new UiError('PREVIEW_DENIED', '演示预览来源不匹配。');
                    this.v.previewUrl = '/sample.html';
                }
                else {
                    const u = new URL(data.url);
                    if (data.scope !== 'TRUSTED_DEMO_SEPARATE_ORIGIN' || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.origin === location.origin)
                        throw new UiError('PREVIEW_DENIED', '现有安全预览不支持该来源；未放宽 iframe 权限。');
                    this.v.previewUrl = u.href;
                }
                this.v.previewScope = data.scope;
            }
            else if (action === 'export') {
                const r = this.v.snapshot.runs[0], data = await this.adapter.exportRun(r.id);
                downloadBlob(data.blob, data.filename);
                this.toast('已向浏览器提交下载；实际保存结果以浏览器为准。');
            }
            else if (['diagnostics', 'models', 'laya-probe'].includes(action)) {
                const path = action === 'diagnostics' ? '/diagnostics' : action === 'models' ? '/diagnostics/models' : '/diagnostics/laya';
                this.v.diagnostics = JSON.stringify(await this.adapter.request(path, action === 'diagnostics' ? 'GET' : 'POST', action === 'diagnostics' ? undefined : {}), null, 2);
            }
        });
    }
    key(ev) {
        if (!this.owned(ev.target))
            return;
        if (this.dialog.open && ev.key === 'Tab') {
            const items = [...this.dialog.querySelectorAll('button:not(:disabled),a[href],input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(x => x.getClientRects().length > 0);
            const i = items.indexOf(document.activeElement);
            if (items.length && (ev.shiftKey && i <= 0 || !ev.shiftKey && (i === items.length - 1 || i < 0))) {
                ev.preventDefault();
                items[ev.shiftKey ? items.length - 1 : 0].focus();
            }
            return;
        }
        if (this.composing || ev.isComposing || ev.keyCode === 229)
            return;
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            const t = ev.target;
            if (t instanceof HTMLTextAreaElement && t.form) {
                ev.preventDefault();
                t.form.requestSubmit();
            }
            return;
        }
        const target = ev.target;
        if (target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
            const tabs = [...this.app.querySelectorAll('[role=tab]')], i = tabs.indexOf(target), n = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            ev.preventDefault();
            tabs[n].click();
            tabs[n].focus();
        }
    }
    renderFixture(data) { if (!document.documentElement.hasAttribute('data-dm-ui-fixture'))
        throw new Error('Fixture marker required'); Object.assign(this.v, { screen: data.screen, projects: data.projects, snapshot: data.snapshot, settings: data.settings, events: data.events || [], tab: data.tab || 'work' }); this.gateDismissed = data.gateDismissed || false; this.render(); const mark = document.createElement('div'); mark.className = 'fixture-watermark'; mark.textContent = 'OFFLINE UI FIXTURE · 无浏览器网络联调'; this.app.prepend(mark); }
    dispose() { if (this.disposed)
        return; this.disposed = true; this.disconnect(); if (this.toastTimer)
        clearTimeout(this.toastTimer); if (this.modalCleanup)
        clearTimeout(this.modalCleanup); this.life.abort(); this.adapter.dispose(); this.dialog.remove(); }
}
