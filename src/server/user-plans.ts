import type { Project, Spec } from '../shared/types.js';
import type { ProjectPlan, PlanRequirement } from '../shared/project-plan.js';
import { USER_PLAN_SCHEMA } from '../shared/product.js';
import { Store } from './store.js';
import { compileSpec, finalizeSpec } from './compile.js';
import { completeProjectPlan } from './project-plan-contract.js';
import { projectPlanInput } from './plan-input.js';
import { canReviseAfterFlow } from './flow/conclusion.js';
import { DomainError, object, text, choose, hash, hasSecret, id, now } from './security.js';

export interface UserPlanDocument { schema:typeof USER_PLAN_SCHEMA; name:string; mode:Project['mode']; plan:Omit<ProjectPlan,'inputBinding'> }
const planKeys=new Set(['goal','requirements','acceptance','architecture','dataModel','interfaces','tasks','delivery','resources','risks','milestones','assumptions','unknowns','outOfScope','research','reuse','inputBinding']);
/** A document is untrusted task data. It cannot import approvals, receipts, budgets or processes. */
/** Which automatic-verification decisions a paragraph already pins. Mirrors the script's own list. */
export function oracleDecisionsFromText(text: string): { name: string; ok: boolean }[] {
    const has = (needle: string) => text.includes(needle);
    const hasDigit = () => [...text].some(c => c >= '0' && c <= '9');
    const hasEntry = has('node ') || has('npm ') || has('.mjs') || has('.js') || has('python');
    const hasSuccessLine = ['ADDED','TICKED','STREAK','LIST','TOTAL','SAVED','OK','打印','输出'].some(has);
    const hasFailure = has('stderr') || has('标准错误') || has('错误码') || has('ERROR');
    const hasExit = (has('退出码') || has('exit')) && hasDigit();
    const hasDataFile = has('.json') || has('.csv') || has('.db') || has('.txt') || has('本地文件') || has('数据文件');
    return [
        { name: '入口命令（例如 node main.mjs）', ok: hasEntry },
        { name: '成功时打印的固定行', ok: hasSuccessLine },
        { name: '失败时写到 stderr 的错误行', ok: hasFailure },
        { name: '失败退出码', ok: hasExit },
        { name: '数据文件名', ok: hasDataFile },
    ];
}
export function readUserPlan(raw:unknown):UserPlanDocument {
    // DreamFlow used to demand an eleven-field JSON document. A paragraph is the honest input, so
    // build the very same document here and let completeProjectPlan validate it exactly as before.
    if(typeof (object(raw) as {text?:unknown}).text==='string'&&Object.keys(object(raw)).every(k=>k==='text'||k==='name'||k==='mode')){
        const paragraph=String((object(raw) as {text:string}).text).trim();
        process.stderr.write('PLAN_FROM_TEXT '+JSON.stringify({chars:paragraph.length})+'\n');
        if(!paragraph)throw new DomainError('USER_PLAN_FORMAT_INVALID',400);
        const requirement={id:'R001',text:paragraph,origin:'USER',sources:['user']} as unknown as PlanRequirement;
        const plan=completeProjectPlan({
            goal:paragraph,
            requirements:[requirement],
            acceptance:[{id:'A001',check:paragraph,requirementIds:['R001']}],
            research:{status:'USER_IMPORTED_PLAN',sourceRefs:[]},
            reuse:{mode:'IMPLEMENT_ORIGINAL',selected:[]},
            architecture:{summary:paragraph,runtime:'local Node.js process',components:['command-line entry']},
            dataModel:{entities:[],persistence:'local data file in the working directory'},
            interfaces:{userFlows:[paragraph],boundaries:[]},
            delivery:{type:'command-line program',howToUse:paragraph,standalone:true,needsInternet:false,ongoingFees:[]},
            resources:{accounts:[],hardware:[],network:[],ongoingCosts:[]},
            tasks:[{id:'T001',title:'implement and self-test the requirement',check:'every requirement line passes its own check',dependsOn:[],requirementIds:['R001']}],
            risks:[],milestones:['deliver a usable build'],assumptions:[],unknowns:[],outOfScope:[],
        },[requirement]);
        const modeFromText=(object(raw) as {mode?:string}).mode==='demo'?'demo':'live';
        const nameFromText=(object(raw) as {name?:string}).name;
        return {schema:USER_PLAN_SCHEMA,name:(nameFromText&&nameFromText.trim())||paragraph.slice(0,40),mode:modeFromText,plan:plan as UserPlanDocument['plan']};
    }
    const input=object(raw);
    if(input.schema!==USER_PLAN_SCHEMA||Object.keys(input).some(k=>!['schema','name','mode','plan'].includes(k)))
        throw new DomainError('USER_PLAN_FORMAT_INVALID',400);
    if(Buffer.byteLength(JSON.stringify(input))>128000)throw new DomainError('USER_PLAN_TOO_LARGE',413);
    if(hasSecret(JSON.stringify(input)))throw new DomainError('USER_PLAN_CONTAINS_SECRET',400,'方案可能包含凭据。请在本地移除后再导入。');
    const plan=structuredClone(object(input.plan));
    if(Object.keys(plan).some(k=>!planKeys.has(k)))throw new DomainError('USER_PLAN_FIELDS_INVALID',400);
    const reuse=object(plan.reuse);
    // Positive source admission is owned by the research authority, never an imported assertion.
    if(reuse.mode!=='IMPLEMENT_ORIGINAL'||!Array.isArray(reuse.selected)||reuse.selected.length)
        throw new DomainError('USER_PLAN_SOURCE_QUALIFICATION_REQUIRED',409,'引用的开源代码需要先由本地来源检查核验，不能以导入文件的声明替代。原方案输入保留，可稍后继续。');
    try {
        const body=completeProjectPlan(plan,Array.isArray(plan.requirements)?plan.requirements.filter((r:unknown)=>object(r).origin==='USER'):[]);
        body.research={...body.research,status:'USER_IMPORTED_PLAN'};
        delete (body as Partial<ProjectPlan>).inputBinding;
        const doc:UserPlanDocument={schema:USER_PLAN_SCHEMA,name:text(input.name,120),mode:choose(input.mode,['demo','live']),plan:body};
        if(Buffer.byteLength(JSON.stringify(doc))>110000)throw new DomainError('USER_PLAN_TOO_LARGE',413);
        return doc;
    }catch(error){
        if(error instanceof DomainError&&error.status===413)throw error;
        const code=error instanceof DomainError?error.code:((error as {code?:unknown})?.code);
        throw new DomainError(typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?code:'USER_PLAN_INVALID',400,'方案尚不完整或要求之间存在冲突；请检查要求、验收和步骤。输入未提交，也没有开始制作。');
    }
}
/** Uses only the existing Store, immutable plan snapshots and Engine ownership contract. */
export class UserPlans {
    constructor(private store:Store){}
    create(raw:unknown,actor:string):Project {
        const doc=readUserPlan(raw),p:Project={id:id('project'),name:doc.name,idea:doc.plan.goal,mode:doc.mode,planner1Mode:'USER',version:1,state:'SPEC_REVIEW',createdAt:now(),updatedAt:now(),questions:[],answers:[],answerHistory:[],batchTarget:0,specId:null,activeRunId:null,warnings:doc.mode==='demo'?['固定 Demo 只检验控制流程，不实现自带方案或调用真实模型。']:[]};
        if(doc.mode==='live')p.userSpendingRequired=true;
        {
            const missing=oracleDecisionsFromText(doc.plan.goal).filter(d=>!d.ok).map(d=>d.name);
            if(missing.length)p.warnings=[...(p.warnings??[]),'自动验收需要补充：'+missing.join('、')+'。缺少这些，构建前不会生成可执行的验收用例；补齐后即可自动验收。'];
        }
        this.store.tx(()=>{this.store.insertProject(p);this.save(p,doc,null,actor);});return this.store.project(p.id);
    }
    revise(pid:string,raw:unknown,version:number,parentId:string,actor:string):Project {
        const doc=readUserPlan(raw),p=this.store.project(pid);
        if(p.version!==version)throw new DomainError('STALE_PROJECT_VERSION',409);
        if(!p.specId||p.specId!==parentId||this.store.planHead(pid)?.id!==parentId)throw new DomainError('STALE_PLAN_PARENT',409);
        if(p.planner1Mode==='USER'&&hash(readUserPlan(this.export(pid)))===hash(doc))return p;
        if(p.activeRunId&&!canReviseAfterFlow(this.store,this.store.run(p.activeRunId)))throw new DomainError('RUN_MUST_STOP_BEFORE_EDIT',409);
        if(doc.mode!==p.mode||doc.name!==p.name)throw new DomainError('USER_PLAN_PROJECT_IDENTITY_CHANGED',409);
        this.store.tx(()=>this.save(p,doc,parentId,actor));return this.store.project(pid);
    }
    export(pid:string):UserPlanDocument {
        const p=this.store.project(pid),s=p.specId?this.store.spec(p.specId):null;
        if(!s?.projectPlan)throw new DomainError('COMPLETE_PROJECT_PLAN_REQUIRED',409);
        const {inputBinding:_controllerBinding,...plan}=structuredClone(s.projectPlan);
        return {schema:USER_PLAN_SCHEMA,name:p.name,mode:p.mode,plan};
    }
    private save(p:Project,doc:UserPlanDocument,parentId:string|null,actor:string){
        const previous=parentId?this.store.spec(parentId):null;
        const importedHash=hash(doc),s:Spec=compileSpec(p,(this.store.planHead(p.id)?.revision??0)+1,'用户提供的完整方案；导入不是确认或开始制作。');
        p.idea=doc.plan.goal;p.planner1Mode='USER';p.state='SPEC_REVIEW';p.specId=s.id;
        this.store.saveProject(p); // The snapshot source must capture the updated input, atomically.
        s.projectVersion=p.version;s.brief=doc.plan.goal;
        s.requirements=doc.plan.requirements.map(r=>({id:r.id,text:r.text,origin:r.origin==='ASSUMPTION'?'DESIGN_ASSUMPTION':r.origin,sourceAnswerIds:[],priority:'must',kind:'unclassified'}));
        s.assumptions=[...doc.plan.assumptions];s.outOfScope=[...doc.plan.outOfScope];s.acceptance=doc.plan.acceptance.map(a=>a.check);
        s.acceptanceItems=doc.plan.acceptance.map(a=>({id:a.id,requirementIds:[...a.requirementIds],criterion:a.check,method:'manual',source:'USER_CONFIRMED',evidenceStatus:'NOT_RUN'}));
        s.projectPlan={...structuredClone(doc.plan),inputBinding:{inputHash:hash(projectPlanInput(p)),projectRevision:p.version,interviewRevision:0,policyHash:hash({schema:USER_PLAN_SCHEMA,authority:'EXPLICIT_USER_DOCUMENT'})}};
        finalizeSpec(s,p.mode);
        if(previous)this.store.saveSpec({...previous,stale:true});
        this.store.revoke(p.id);this.store.saveSpec(s,parentId);
        this.store.record('UserPlanImported',p.id,null,{actor,document:doc,documentHash:importedHash,specId:s.id,specHash:s.hash,trust:'USER_PROVIDED_DATA_NOT_SOURCE_QUALIFICATION',approvalImported:false});
        for(const requirement of s.requirements)this.store.record('Requirement',p.id,null,{specId:s.id,...requirement});
        this.store.record('PromptBundle',p.id,null,{specId:s.id,specHash:s.hash,skillMode:s.skillMode});
        this.store.event(p.id,null,'spec.created',{specId:s.id,hash:s.hash,origin:'USER_DOCUMENT'});
    }
}
