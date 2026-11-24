/** Small keyed DOM reconciliation: preserve focused controls, IME composition, selection, details and iframe identity. */
const nodeKey = (node: Node): string | null => node instanceof Element ? node.getAttribute('data-key') || node.id || null : null;
function compatible(a: Node,b: Node): boolean { return a.nodeType === b.nodeType && (!(a instanceof Element) || (b instanceof Element && a.tagName === b.tagName && nodeKey(a) === nodeKey(b))); }
export function patchChildren(parent: Node, desired: Node): void {
  const old = [...parent.childNodes]; const keyed = new Map(old.map(n=>[nodeKey(n),n]).filter(([k])=>k) as [string,Node][]);
  let cursor: ChildNode | null = parent.firstChild;
  for (const next of [...desired.childNodes]) {
    const key = nodeKey(next);
    let current = key ? keyed.get(key) : cursor;
    if (!current || !compatible(current,next)) {
      const added = next.cloneNode(true); parent.insertBefore(added,cursor); current = added;
    } else {
      if (current !== cursor) parent.insertBefore(current,cursor);
      if (current instanceof Element && next instanceof Element) {
        const formControl = /^(INPUT|TEXTAREA|SELECT)$/.test(current.tagName);
        for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name) && !(formControl && ['value','checked','selected'].includes(attr.name)) && !(current.tagName === 'DETAILS' && attr.name === 'open')) current.removeAttribute(attr.name);
        for (const attr of [...next.attributes]) if (!(formControl && ['value','checked','selected'].includes(attr.name)) && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name,attr.value);
        if (!formControl && current.tagName !== 'IFRAME') patchChildren(current,next);
      } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    }
    cursor = current.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
}
export function patchHtml(target: Element, html: string): void { const template = document.createElement('template'); template.innerHTML = html; patchChildren(target,template.content); }
export function downloadBlob(blob: Blob,name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href=url; a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export class DraftStore {
  private values = new Map<string,string>();
  constructor(private namespace: string,private maxValueLength=16000) { try { const saved = JSON.parse(sessionStorage.getItem(namespace) || '{}'); for(const [k,v] of Object.entries(saved)) if(typeof v === 'string' && k.length<200 && v.length<=maxValueLength) this.values.set(k,v); } catch { /* Private or blocked storage: memory only. */ } }
  get(key:string):string { return this.values.get(key) ?? ''; }
  has(key:string):boolean { return this.values.has(key); }
  set(key:string,value:string):boolean { if(key.length>=200||value.length>this.maxValueLength)return false;this.values.set(key,value);this.save();return true; }
  delete(key:string):void { this.values.delete(key); this.save(); }
  /** Required operation references never share the evictable, memory-fallback draft cache. */
  getRequired(key:string):string { if(key.length>=200)throw new Error('REQUIRED_DRAFT_KEY_INVALID');return localStorage.getItem(this.namespace+':required:'+key)??''; }
  setRequired(key:string,value:string):boolean {
    if(key.length>=200||value.length>this.maxValueLength)return false;
    try{const target=this.namespace+':required:'+key;localStorage.setItem(target,value);return localStorage.getItem(target)===value;}catch{return false;}
  }
  deleteRequired(key:string,expectedValue?:string):boolean {
    if(key.length>=200)return false;
    try{const target=this.namespace+':required:'+key;if(expectedValue!==undefined&&localStorage.getItem(target)!==expectedValue)return false;localStorage.removeItem(target);return localStorage.getItem(target)===null;}catch{return false;}
  }
  async withRequiredLock<T>(key:string,work:()=>Promise<T>):Promise<T> {
    if(key.length>=200||typeof navigator==='undefined'||!navigator.locks)throw Object.assign(new Error('Required operation lock unavailable'),{code:'REQUIRED_DRAFT_LOCK_UNAVAILABLE'});
    return navigator.locks.request(this.namespace+':required:'+key,{ifAvailable:true},async lock=>{
      if(!lock)throw Object.assign(new Error('Required operation lock busy'),{code:'REQUIRED_DRAFT_LOCK_UNAVAILABLE'});
      return work();
    });
  }
  private save():void { try { sessionStorage.setItem(this.namespace,JSON.stringify(Object.fromEntries([...this.values].slice(-60)))); } catch { /* Existing in-memory draft remains usable. */ } }
}
