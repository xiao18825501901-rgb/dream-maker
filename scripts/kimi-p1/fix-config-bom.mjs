import { readFileSync, writeFileSync } from 'node:fs';
const p = process.argv[2];
let s = readFileSync(p, "utf8");
if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
const obj = JSON.parse(s);
writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
console.log("REWROTE_NO_BOM", Object.keys(obj).length);
