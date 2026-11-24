// Build the exact POST /api/projects/<id>/semantics body for the owner and prove the product's own
// validator accepts it. Nothing is written to the store; the owner submits it.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { validateSemanticRevision } from '../dist/server/semantics.js';
const pid = 'project_61e87535ed77322b7012';
const db = new DatabaseSync('.runtime/dream-maker.sqlite', { readOnly: true });
const project = JSON.parse(String(db.prepare('SELECT data FROM projects WHERE id = ?').get(pid).data));
const spec = JSON.parse(String(db.prepare('SELECT data FROM specs WHERE id = ?').get(project.specId).data));
db.close();
const ids = spec.requirements.map(r => r.id);
const requirements = ids.map(id => ({ id, kind: 'functional', priority: 'must' }));
const acceptanceItems = [
  { id: 'A1-entry', requirementIds: ['R001', 'R002'], criterion: '交付包含 main.mjs；node main.mjs help 在 stdout 打印以 USAGE 开头的一行并 exit 0；子命令仅有 add/tick/streak/list/help。', method: 'manual' },
  { id: 'A2-success-lines', requirementIds: ['R003', 'R004'], criterion: 'add 打印一行 ADDED <name>；tick 打印 TICKED <name> <date>；streak 打印 STREAK <name> <n>；list 先打印 LIST <count> 再按名字升序每行一个 <name>；均为单行并以换行结尾。', method: 'manual' },
  { id: 'A3-error-codes', requirementIds: ['R005', 'R006'], criterion: '任何失败只向 stderr 打印一行 ERROR <code> 且 exit 3、stdout 为空；码表固定：NO_SUCH_ITEM、BAD_DATE（非严格 YYYY-MM-DD、非真实日历日、或 tick 晚于当日）、DUPLICATE_TICK、BAD_ARGS（参数缺失或多余、--name 长度不在 1 到 32）、UNKNOWN_COMMAND。', method: 'manual' },
  { id: 'A4-date-and-streak', requirementIds: ['R007', 'R008'], criterion: 'tick 用 --date、streak 用 --today，严格 YYYY-MM-DD 且必须是真实日历日；streak 从 --today 起向前逐自然日回溯，遇到第一个没有 tick 的日期即停止；没有任何记录时为 0；不允许补签。', method: 'manual' },
  { id: 'A5-storage-and-fixture', requirementIds: ['R009', 'R010'], criterion: '数据文件为 JSON 对象，键 items 映射名字到日期数组，同一天只保留一次并升序；交付必须包含固定样例数据文件 sample.json，其内容严格为 items.water = 2026-01-01, 2026-01-02, 2026-01-03 三个日期，验收以该文件注入状态。', method: 'manual' },
  { id: 'A6-names-and-edges', requirementIds: ['R011'], criterion: '--name 长度 1..32，允许字母、数字、下划线与中文；重复 add 同名仍打印 ADDED <name> 且不重复插入；空清单 list 打印 LIST 0；某名字没有 tick 记录时 streak 打印 STREAK <name> 0。', method: 'manual' },
];
const payload = { specHash: spec.hash, confirmed: true, requirements, acceptanceItems };
let ok = true;
try {
  // The route strips specHash before validating (it is the binding, not a semantic field).
  const { specHash: _ignored, ...confirmation } = payload;
  const validated = validateSemanticRevision(spec, confirmation);
  const covered = new Set(validated.acceptanceItems.flatMap(a => a.requirementIds));
  const missing = ids.filter(id => !covered.has(id));
  console.log('VALIDATION_OK requirements=' + validated.requirements.length + ' acceptanceItems=' + validated.acceptanceItems.length + ' coverage=' + (missing.length === 0 ? 'all ' + ids.length : 'MISSING ' + missing.join(',')));
} catch (error) {
  ok = false;
  console.log('VALIDATION_FAILED ' + String(error?.code ?? error?.message ?? error));
}
writeFileSync('delivery/semantic-confirmation.json', JSON.stringify(payload, null, 2) + String.fromCharCode(10));
console.log('WROTE delivery/semantic-confirmation.json');
console.log('OWNER: POST http://127.0.0.1:4317/api/projects/' + pid + '/semantics with headers x-csrf-token + idempotency-key and this body');
process.exitCode = ok ? 0 : 1;