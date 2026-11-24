/** Small keyed DOM reconciliation: preserve focused controls, IME composition, selection, details and iframe identity. */
const nodeKey = (node) => node instanceof Element ? node.getAttribute('data-key') || node.id || null : null;
function compatible(a, b) { return a.nodeType === b.nodeType && (!(a instanceof Element) || (b instanceof Element && a.tagName === b.tagName && nodeKey(a) === nodeKey(b))); }
export function patchChildren(parent, desired) {
    const old = [...parent.childNodes];
    const keyed = new Map(old.map(n => [nodeKey(n), n]).filter(([k]) => k));
    let cursor = parent.firstChild;
    for (const next of [...desired.childNodes]) {
        const key = nodeKey(next);
        let current = key ? keyed.get(key) : cursor;
        if (!current || !compatible(current, next)) {
            const added = next.cloneNode(true);
            parent.insertBefore(added, cursor);
            current = added;
        }
        else {
            if (current !== cursor)
                parent.insertBefore(current, cursor);
            if (current instanceof Element && next instanceof Element) {
                const formControl = /^(INPUT|TEXTAREA|SELECT)$/.test(current.tagName);
                for (const attr of [...current.attributes])
                    if (!next.hasAttribute(attr.name) && !(formControl && ['value', 'checked', 'selected'].includes(attr.name)) && !(current.tagName === 'DETAILS' && attr.name === 'open'))
                        current.removeAttribute(attr.name);
                for (const attr of [...next.attributes])
                    if (!(formControl && ['value', 'checked', 'selected'].includes(attr.name)) && current.getAttribute(attr.name) !== attr.value)
                        current.setAttribute(attr.name, attr.value);
                if (!formControl && current.tagName !== 'IFRAME')
                    patchChildren(current, next);
            }
            else if (current.nodeValue !== next.nodeValue)
                current.nodeValue = next.nodeValue;
        }
        cursor = current.nextSibling;
    }
    while (cursor) {
        const next = cursor.nextSibling;
        parent.removeChild(cursor);
        cursor = next;
    }
}
export function patchHtml(target, html) { const template = document.createElement('template'); template.innerHTML = html; patchChildren(target, template.content); }
export function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export class DraftStore {
    namespace;
    values = new Map();
    constructor(namespace) {
        this.namespace = namespace;
        try {
            const saved = JSON.parse(sessionStorage.getItem(namespace) || '{}');
            for (const [k, v] of Object.entries(saved))
                if (typeof v === 'string' && k.length < 200 && v.length <= 16000)
                    this.values.set(k, v);
        }
        catch { /* Private or blocked storage: memory only. */ }
    }
    get(key) { return this.values.get(key) ?? ''; }
    has(key) { return this.values.has(key); }
    set(key, value) { this.values.set(key, value.slice(0, 16000)); this.save(); }
    delete(key) { this.values.delete(key); this.save(); }
    save() { try {
        sessionStorage.setItem(this.namespace, JSON.stringify(Object.fromEntries([...this.values].slice(-60))));
    }
    catch { /* Existing in-memory draft remains usable. */ } }
}
