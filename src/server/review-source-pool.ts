import {DomainError,hash,object} from './security.js';
import {assertReviewMaterialSafe} from './review-material.js';

const WIRE_LIMIT=512000;
const EXPANDED_LIMIT=2*1024*1024;
const fail=():never=>{throw new DomainError('REVIEW_SOURCE_POOL_INVALID',409);};
const tooLarge=():never=>{throw new DomainError('REVIEW_PACKET_LIMIT',413);};
const record=(value:unknown):Record<string,unknown>=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return fail();
    return value as Record<string,unknown>;
};
const keyOk=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const jsonBytes=(value:unknown)=>{const serialized=JSON.stringify(value);return serialized===undefined?0:Buffer.byteLength(serialized);};
const put=(pool:Record<string,unknown>,key:string,value:unknown)=>{
    if(Object.hasOwn(pool,key)&&hash(pool[key])!==hash(value))return fail();
    pool[key]=value;
};
const sameKeys=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).sort().join(',')===keys.slice().sort().join(',');

/** Reconstruct the exact witness fields the trusted verifier stores beside each
 * observed case. These values are already present in planText; keeping a second
 * copy in every attempt wastes the one-message review budget. */
function planCaseWitness(raw:unknown){
    const c=record(raw);
    if(Object.hasOwn(c,'input')||Object.hasOwn(c,'expected')){
        if(!Object.hasOwn(c,'input')||!Object.hasOwn(c,'expected'))return fail();
        return {input:structuredClone(record(c.input)),expected:structuredClone(record(c.expected))};
    }
    const input=record({runtime:c.runtime,entry:c.entry,args:c.args,stdin:c.stdin});
    if(!Array.isArray(c.args)||c.args.some(value=>typeof value!=='string'))return fail();
    if(c.fixtures!==undefined)input.fixtures={...record(c.fixtures)};
    const expected:Record<string,unknown>={exitCode:c.expectedExitCode};
    if(Object.hasOwn(c,'expectedJson'))expected.json=c.expectedJson;
    else if(Object.hasOwn(c,'expectedStdout'))expected.stdout=c.expectedStdout;
    else if(Object.hasOwn(c,'expectedStdoutPrefix'))expected.stdoutPrefix=c.expectedStdoutPrefix;
    else if(Object.hasOwn(c,'expectedStdoutMatch'))expected.stdoutMatch=c.expectedStdoutMatch;
    else return fail();
    if(Object.hasOwn(c,'expectedStderr'))expected.stderr=c.expectedStderr;
    else if(Object.hasOwn(c,'expectedStderrPrefix'))expected.stderrPrefix=c.expectedStderrPrefix;
    else if(Object.hasOwn(c,'expectedStderrMatch'))expected.stderrMatch=c.expectedStderrMatch;
    return {input,expected};
}

function plannedWitnessFields(observed:Record<string,unknown>,planCases:unknown[],index:number){
    const planCase=planCases[index];
    if(planCase===undefined)return [];
    const witness=planCaseWitness(planCase);
    if(observed.id!==record(planCase).id)return [];
    return ['input','expected'].filter(name=>Object.hasOwn(observed,name)&&hash(observed[name])===hash(witness[name as 'input'|'expected']));
}

/** Share the large, canonical verifier stdout document by its repeated plan and
 * case objects. The exact stdout bytes and every case remain reconstructible. */
function poolRawVerifierStdout<T extends Record<string,unknown>>(packet:T):T{
    if(packet.rawTestDataEncoding!=='CONTENT_POOL_V1'||!packet.rawTestDataPool)return packet;
    const dataPool=record(packet.rawTestDataPool),nextDataPool:Record<string,unknown>=Object.create(null),stdoutPool:Record<string,unknown>=Object.create(null),
        planTextPool:Record<string,unknown>=Object.create(null),casePool:Record<string,unknown>=Object.create(null),
        pending:{dataKey:string;data:Record<string,unknown>;stdout:string;raw:Record<string,unknown>;planCases:unknown[]|null}[]=[];
    const mapping=new Map<string,string>();
    for(const [dataKey,rawData] of Object.entries(dataPool)){
        const data=record(rawData);
        if(Object.hasOwn(data,'stdoutRef'))return fail();
        if(typeof data.stdout!=='string')continue;
        let raw:Record<string,unknown>;
        try{raw=record(JSON.parse(data.stdout));}catch{continue;}
        if(!['dream-maker.trusted-cli-evidence.v1','dream-maker.trusted-cli-evidence.v2'].includes(String(raw.schema))||
            typeof raw.planText!=='string'||!Array.isArray(raw.cases)||JSON.stringify(raw)!==data.stdout)continue;
        let planCases:unknown[]|null=null;
        try{
            const plan=record(JSON.parse(raw.planText)),cases=plan.cases;
            if(Array.isArray(cases)&&cases.length===raw.cases.length)planCases=cases;
        }catch{}
        pending.push({dataKey,data,stdout:data.stdout,raw,planCases});
    }
    if(!pending.length)return packet;
    const repeatedValues=new Map<string,{count:number;bytes:number}>(),valueKey=(name:string,value:unknown)=>name+'\0'+hash(value);
    for(const {raw} of pending)for(const value of raw.cases as unknown[]){
        const observed=record(value);
        for(const [name,field] of Object.entries(observed)){
            const bytes=jsonBytes(field);
            if(bytes<64)continue;
            const key=valueKey(name,field),entry=repeatedValues.get(key);
            repeatedValues.set(key,{count:(entry?.count??0)+1,bytes});
        }
    }
    const worthSharing=({count,bytes}:{count:number;bytes:number})=>count>1&&bytes*(count-1)>bytes+count*96;
    const shareValues=[...repeatedValues.values()].some(worthSharing),caseValuePool:Record<string,unknown>=Object.create(null);
    let descriptorEncoding=false;
    for(const {dataKey,data,stdout,raw,planCases} of pending){
        const planText=raw.planText as string,planRef=hash(planText),encodedCases=(raw.cases as unknown[]).map((value,index)=>{
            const observed=record(value),witnessFields=planCases?plannedWitnessFields(observed,planCases,index):[];
            if(!shareValues&&!witnessFields.length)return {ref:hash(value),descriptor:null};
            const fieldOrder=Object.keys(observed),fields:Record<string,unknown>=Object.create(null),valueRefs:Record<string,string>=Object.create(null);
            for(const name of fieldOrder){
                if(witnessFields.includes(name))continue;
                const entry=Object.hasOwn(observed,name)?repeatedValues.get(valueKey(name,observed[name])):undefined;
                const selected=!!entry&&worthSharing(entry);
                if(!selected){fields[name]=observed[name];continue;}
                const ref=hash(observed[name]);put(caseValuePool,ref,observed[name]);valueRefs[name]=ref;
            }
            const descriptor={schema:'dream-maker.raw-verifier-case-pool.v2',fieldOrder,fields,valueRefs,
                ...(witnessFields.length?{planWitnessFields:witnessFields}:{})};
            return {ref:hash(descriptor),descriptor};
        });
        const useDescriptors=shareValues||encodedCases.some(item=>item.descriptor!==null);
        descriptorEncoding||=useDescriptors;
        const caseRefs=encodedCases.map(({ref,descriptor},index)=>{
            if(descriptor)put(casePool,ref,descriptor);
            else put(casePool,ref,record((raw.cases as unknown[])[index]));
            return ref;
        });
        put(planTextPool,planRef,planText);
        const fieldOrder=Object.keys(raw),fields:Record<string,unknown>=Object.create(null);
        for(const [key,value] of Object.entries(raw))if(key!=='planText'&&key!=='cases')fields[key]=value;
        const descriptor={schema:useDescriptors?'dream-maker.raw-verifier-stdout-pool.v2':'dream-maker.raw-verifier-stdout-pool.v1',
            fieldOrder,fields,planTextRef:planRef,casesRef:caseRefs,
            stdoutSha256:hash(stdout),stdoutBytes:Buffer.byteLength(stdout)};
        const stdoutRef=hash(descriptor);put(stdoutPool,stdoutRef,descriptor);
        const {stdout:_stdout,...rest}=data;
        const next={...rest,stdoutRef},nextKey=hash(next);put(nextDataPool,nextKey,next);
        mapping.set(dataKey,nextKey);
    }
    for(const [key,value] of Object.entries(dataPool))if(!mapping.has(key))put(nextDataPool,key,value);
    const rawTests=record({rawTests:packet.rawTests}).rawTests;
    if(!Array.isArray(rawTests))return fail();
    const updatedRawTests=rawTests.map(raw=>{
        const test=record(raw);
        if(typeof test.recordId!=='string'||typeof test.dataRef!=='string'||!Object.hasOwn(dataPool,test.dataRef))return fail();
        return {...test,dataRef:mapping.get(test.dataRef)??test.dataRef};
    });
    return {...packet,rawTests:updatedRawTests,rawTestDataPool:nextDataPool,
        rawVerifierStdoutEncoding:descriptorEncoding?'CONTENT_POOL_V2':'CONTENT_POOL_V1',rawVerifierStdoutPool:stdoutPool,
        rawVerifierPlanTextPool:planTextPool,rawVerifierCasePool:casePool,
        ...(descriptorEncoding?{rawVerifierCaseValuePool:caseValuePool}:{})} as T;
}

function expandRawVerifierStdout(packet:Record<string,unknown>,tests:Record<string,unknown>[]):Record<string,unknown>[]{
    const marker=packet.rawVerifierStdoutEncoding;
    if(marker===undefined){
        if(packet.rawVerifierStdoutPool!==undefined||packet.rawVerifierPlanTextPool!==undefined||packet.rawVerifierCasePool!==undefined||
            packet.rawVerifierCaseValuePool!==undefined||
            tests.some(test=>{
                const data=test.data;
                return !!data&&typeof data==='object'&&!Array.isArray(data)&&Object.hasOwn(data as Record<string,unknown>,'stdoutRef');
            }))return fail();
        return tests;
    }
    const valuePoolEncoded=marker==='CONTENT_POOL_V2';
    if((marker!=='CONTENT_POOL_V1'&&!valuePoolEncoded)||!packet.rawVerifierStdoutPool||!packet.rawVerifierPlanTextPool||
        !packet.rawVerifierCasePool||valuePoolEncoded&&!packet.rawVerifierCaseValuePool||
        !valuePoolEncoded&&packet.rawVerifierCaseValuePool!==undefined)return fail();
    const stdoutPool=record(packet.rawVerifierStdoutPool),planTextPool=record(packet.rawVerifierPlanTextPool),casePool=record(packet.rawVerifierCasePool),
        caseValuePool=valuePoolEncoded?record(packet.rawVerifierCaseValuePool):Object.create(null) as Record<string,unknown>,
        usedStdout=new Set<string>(),usedPlans=new Set<string>(),usedCases=new Set<string>(),usedCaseValues=new Set<string>();
    for(const [key,raw] of Object.entries(planTextPool)){
        if(!keyOk(key)||typeof raw!=='string'||hash(raw)!==key)return fail();
    }
    if(!valuePoolEncoded)for(const [key,raw] of Object.entries(casePool))if(!keyOk(key)||hash(raw)!==key)return fail();
    else for(const [key,raw] of Object.entries(caseValuePool))if(!keyOk(key)||hash(raw)!==key)return fail();
    let expandedStdoutBytes=0;
    const expandedStdout=new Map<string,string>();
    for(const [key,descriptor] of Object.entries(stdoutPool)){
        const d=record(descriptor);
        if(!keyOk(key)||!sameKeys(d,['casesRef','fieldOrder','fields','planTextRef','schema','stdoutBytes','stdoutSha256'])||
            d.schema!==(valuePoolEncoded?'dream-maker.raw-verifier-stdout-pool.v2':'dream-maker.raw-verifier-stdout-pool.v1')||
            hash(d)!==key||!keyOk(d.planTextRef)||
            !Array.isArray(d.casesRef)||!d.casesRef.every(keyOk)||!Array.isArray(d.fieldOrder)||
            typeof d.stdoutSha256!=='string'||!/^[a-f0-9]{64}$/.test(d.stdoutSha256)||!Number.isSafeInteger(d.stdoutBytes)||
            Number(d.stdoutBytes)<0)
            return fail();
        if(Number(d.stdoutBytes)>EXPANDED_LIMIT)return tooLarge();
        const fields=record(d.fields),order=d.fieldOrder;
        if(order.length!==new Set(order).size||order.some(value=>typeof value!=='string')||order.filter(value=>value==='planText').length!==1||
            order.filter(value=>value==='cases').length!==1||Object.hasOwn(fields,'planText')||Object.hasOwn(fields,'cases')||
            Object.keys(fields).length!==order.length-2||!Object.keys(fields).every(value=>order.includes(value)))
            return fail();
        if(!Object.hasOwn(planTextPool,d.planTextRef))return fail();
        const planText=planTextPool[d.planTextRef];
        let planCases:unknown[]|null=null;
        try{
            const plan=record(JSON.parse(String(planText))),cases=plan.cases;
            if(Array.isArray(cases)&&cases.length===d.casesRef.length)planCases=cases;
        }catch{}
        let casesBytes=2;
        const caseRefs=d.casesRef as string[];
        const expandedCases=caseRefs.map((ref,index)=>{
            if(!Object.hasOwn(casePool,ref))return fail();
            usedCases.add(ref);
            const pooledCase=record(casePool[ref]);
            if(!valuePoolEncoded){
                casesBytes+=Buffer.byteLength(JSON.stringify(pooledCase))+(index?1:0);
                return pooledCase;
            }
            const hasPlanWitness=Object.hasOwn(pooledCase,'planWitnessFields');
            const descriptorKeys=hasPlanWitness
                ?['fieldOrder','fields','planWitnessFields','schema','valueRefs']
                :['fieldOrder','fields','schema','valueRefs'];
            if(!sameKeys(pooledCase,descriptorKeys)||
                pooledCase.schema!=='dream-maker.raw-verifier-case-pool.v2'||hash(pooledCase)!==ref||
                !Array.isArray(pooledCase.fieldOrder)||!Array.isArray(d.casesRef))return fail();
            const order=pooledCase.fieldOrder as string[],fields=record(pooledCase.fields),refs=record(pooledCase.valueRefs);
            const planWitnessFields=hasPlanWitness?pooledCase.planWitnessFields:[]; 
            if(!Array.isArray(planWitnessFields)||planWitnessFields.some(name=>name!=='input'&&name!=='expected')||
                planWitnessFields.length!==new Set(planWitnessFields).size||
                planWitnessFields.some(name=>!order.includes(name))||
                order.length!==new Set(order).size||order.some(value=>typeof value!=='string')||
                Object.keys(fields).length+Object.keys(refs).length+planWitnessFields.length!==order.length||
                !Object.keys(fields).every(name=>order.includes(name))||!Object.keys(refs).every(name=>order.includes(name))||
                planWitnessFields.some(name=>Object.hasOwn(fields,name)||Object.hasOwn(refs,name)))return fail();
            const reconstructed:Record<string,unknown>=Object.create(null);
            for(const name of order){
                if(planWitnessFields.includes(name))continue;
                const hasField=Object.hasOwn(fields,name),hasRef=Object.hasOwn(refs,name);
                if(hasField===hasRef)return fail();
                if(hasRef){
                    const valueRef=refs[name];
                    if(!keyOk(valueRef)||!Object.hasOwn(caseValuePool,valueRef))return fail();
                    usedCaseValues.add(valueRef);reconstructed[name]=caseValuePool[valueRef];
                }else reconstructed[name]=fields[name];
            }
            if(planWitnessFields.length){
                if(!planCases||typeof reconstructed.id!=='string')return fail();
                const witness=planCaseWitness(planCases[index]);
                if(reconstructed.id!==record(planCases[index]).id)return fail();
                for(const name of planWitnessFields)reconstructed[name]=witness[name as 'input'|'expected'];
            }
            const ordered:Record<string,unknown>=Object.create(null);
            for(const name of order){
                if(!Object.hasOwn(reconstructed,name))return fail();
                ordered[name]=reconstructed[name];
            }
            casesBytes+=Buffer.byteLength(JSON.stringify(reconstructed))+(index?1:0);
            return ordered;
        });
        if(casesBytes>EXPANDED_LIMIT)return tooLarge();
        const projectedBytes=casesBytes+Buffer.byteLength(String(planText))+Buffer.byteLength(JSON.stringify(fields));
        if(projectedBytes>EXPANDED_LIMIT)return tooLarge();
        const raw:Record<string,unknown>=Object.create(null);
        for(const name of order){
            if(name==='planText'){
                raw[name]=planText;usedPlans.add(d.planTextRef);
            }else if(name==='cases'){
                raw[name]=expandedCases;
            }else raw[name]=fields[name];
        }
        const stdout=JSON.stringify(raw);
        const stdoutBytes=Buffer.byteLength(stdout);
        if(hash(stdout)!==d.stdoutSha256||stdoutBytes!==d.stdoutBytes)return fail();
        expandedStdoutBytes+=stdoutBytes;
        if(expandedStdoutBytes>EXPANDED_LIMIT)return tooLarge();
        expandedStdout.set(key,stdout);
    }
    const expanded=tests.map(test=>{
        const data=record(test.data);
        if(!Object.hasOwn(data,'stdoutRef'))return test;
        if(typeof data.stdoutRef!=='string'||!Object.hasOwn(stdoutPool,data.stdoutRef)||Object.hasOwn(data,'stdout'))return fail();
        usedStdout.add(data.stdoutRef);
        const stdout=expandedStdout.get(data.stdoutRef);
        if(stdout===undefined)return fail();
        const {stdoutRef:_ref,...rest}=data;
        return {...test,data:{...rest,stdout}};
    });
    if(usedStdout.size!==Object.keys(stdoutPool).length||usedPlans.size!==Object.keys(planTextPool).length||usedCases.size!==Object.keys(casePool).length||
        valuePoolEncoded&&usedCaseValues.size!==Object.keys(caseValuePool).length)return fail();
    return expanded;
}

function poolSourceContentDeltas(packet:Record<string,unknown>):Record<string,unknown>{
    const pool=record(packet.sourceContentPool),sourceHistory=packet.sourceHistory;
    if(!Array.isArray(sourceHistory))return fail();
    const order:string[]=[],seen=new Set<string>(),firstPath=new Map<string,string>();
    for(const rawSnapshot of sourceHistory){
        const snapshot=record(rawSnapshot),files=snapshot.files;
        if(!Array.isArray(files))return fail();
        for(const rawFile of files){
            const file=record(rawFile),ref=file.contentRef;
            if(typeof ref!=='string'||typeof file.path!=='string')return fail();
            if(!seen.has(ref)){seen.add(ref);order.push(ref);}
            if(!firstPath.has(ref))firstPath.set(ref,file.path);
        }
    }
    if(order.length!==Object.keys(pool).length)return fail();
    const previous=new Map<string,string>(),contentByRef=new Map<string,Record<string,unknown>>(),nextPool:Record<string,unknown>=Object.create(null);
    for(const ref of order){
        const entry=record(pool[ref]);
        if(!sameKeys(entry,['bytes','content','encoding','sha256'])||typeof entry.content!=='string'||
            !['utf8','base64'].includes(String(entry.encoding))||!Number.isSafeInteger(entry.bytes)||
            typeof entry.sha256!=='string'||hash(entry)!==ref)return fail();
        contentByRef.set(ref,entry);
        const path=firstPath.get(ref)!,baseRef=previous.get(path);
        let encoded:Record<string,unknown>=entry;
        if(baseRef&&entry.encoding==='utf8'){
            const base=contentByRef.get(baseRef);
            if(base?.encoding==='utf8'&&typeof base.content==='string'){
                const before=base.content,after=entry.content;
                let prefixLength=0;while(prefixLength<before.length&&prefixLength<after.length&&before[prefixLength]===after[prefixLength])prefixLength++;
                let suffixLength=0;
                while(suffixLength<before.length-prefixLength&&suffixLength<after.length-prefixLength&&
                    before[before.length-1-suffixLength]===after[after.length-1-suffixLength])suffixLength++;
                const delta={schema:'dream-maker.source-content-delta.v1',baseRef,prefixLength,suffixLength,
                    middle:after.slice(prefixLength,after.length-suffixLength),bytes:entry.bytes,sha256:entry.sha256};
                if(jsonBytes(delta)<jsonBytes(entry))encoded=delta;
            }
        }
        nextPool[ref]=encoded;
        previous.set(path,ref);
    }
    return {...packet,sourceContentEncoding:'CONTENT_POOL_V2',sourceContentPool:nextPool};
}

/** Lossless source-only dictionary. Snapshot hashes remain hashes of the original
 * expanded bytes; neither test evidence nor execution history is shortened. */
export function poolReviewSources<T extends {sourceHistory:unknown[]}>(packet:T){
    const sourceContentPool:Record<string,Record<string,unknown>>=Object.create(null);
    const sourceHistory=packet.sourceHistory.map(raw=>{
        const snapshot=object(raw);
        if(!Array.isArray(snapshot.files))return fail();
        return {...snapshot,files:snapshot.files.map(rawFile=>{
            const file=object(rawFile),{content,...rest}=file;
            const entry={content,encoding:file.encoding,bytes:file.bytes,sha256:file.sha256},key=hash(entry);
            sourceContentPool[key]=entry;
            return {...rest,contentRef:key};
        })};
    });
    let pooled:Record<string,unknown>={...packet,sourceHistory,sourceContentEncoding:'CONTENT_POOL_V1',sourceContentPool};
    if(Buffer.byteLength(JSON.stringify(pooled))>WIRE_LIMIT&&Array.isArray(pooled.rawTests)){
        const rawTestDataPool:Record<string,unknown>=Object.create(null);
        const rawTests=pooled.rawTests.map(raw=>{
            const test=object(raw);
            if(Object.keys(test).sort().join(',')!=='data,recordId'||typeof test.recordId!=='string')return fail();
            const key=hash(test.data);rawTestDataPool[key]=test.data;
            return {recordId:test.recordId,dataRef:key};
        });
        pooled={...pooled,rawTests,rawTestDataEncoding:'CONTENT_POOL_V1',rawTestDataPool};
    }
    if(Buffer.byteLength(JSON.stringify(pooled))>WIRE_LIMIT)pooled=poolRawVerifierStdout(pooled);
    if(pooled.sourceContentEncoding==='CONTENT_POOL_V1'){
        const delta=poolSourceContentDeltas(pooled);
        if(Buffer.byteLength(JSON.stringify(delta))<Buffer.byteLength(JSON.stringify(pooled)))pooled=delta;
    }
    if(Buffer.byteLength(JSON.stringify(pooled))>WIRE_LIMIT&&process.env.DREAM_MAKER_REVIEW_POOL_DIAG==='1'){
        const sections=Object.fromEntries(Object.entries(pooled).map(([key,value])=>[key,Buffer.byteLength(JSON.stringify(value))]));
        const execution=record(pooled.executionEvidence??{});
        const executionSections=Object.fromEntries(Object.entries(execution).map(([key,value])=>[key,Buffer.byteLength(JSON.stringify(value))]));
        console.error(JSON.stringify({bytes:Buffer.byteLength(JSON.stringify(pooled)),sections,executionSections}));
    }
    if(Buffer.byteLength(JSON.stringify(pooled))>WIRE_LIMIT)throw new DomainError('REVIEW_PACKET_LIMIT',413);
    expandReviewSourcePool(pooled);
    expandReviewTestDataPool(pooled);
    return pooled;
}

/** Strictly validate and expand before admission. Bounded expanded history uses
 * the same original limit, so tiny references cannot create a decompression bomb. */
export function expandReviewSourcePool(packet:Record<string,unknown>):Record<string,unknown>[] {
    const encoding=packet.sourceContentEncoding;
    if((encoding!=='CONTENT_POOL_V1'&&encoding!=='CONTENT_POOL_V2')||!Array.isArray(packet.sourceHistory)||
        Buffer.byteLength(JSON.stringify(packet))>WIRE_LIMIT)return fail();
    const pool=object(packet.sourceContentPool),used=new Set<string>(),decoded=new Map<string,Record<string,unknown>>(),visiting=new Set<string>();
    const decode=(ref:string):Record<string,unknown>=>{
        const cached=decoded.get(ref);if(cached)return cached;
        if(!keyOk(ref)||!Object.hasOwn(pool,ref)||visiting.has(ref))return fail();
        visiting.add(ref);
        const raw=object(pool[ref]);
        let entry:Record<string,unknown>;
        if(encoding==='CONTENT_POOL_V2'&&raw.schema==='dream-maker.source-content-delta.v1'){
            if(!sameKeys(raw,['baseRef','bytes','middle','prefixLength','schema','sha256','suffixLength'])||
                !keyOk(raw.baseRef)||!Number.isSafeInteger(raw.prefixLength)||Number(raw.prefixLength)<0||
                !Number.isSafeInteger(raw.suffixLength)||Number(raw.suffixLength)<0||typeof raw.middle!=='string')return fail();
            const base=decode(raw.baseRef);
            if(base.encoding!=='utf8'||typeof base.content!=='string')return fail();
            const prefixLength=Number(raw.prefixLength),suffixLength=Number(raw.suffixLength);
            if(prefixLength+suffixLength>base.content.length)return fail();
            entry={content:base.content.slice(0,prefixLength)+raw.middle+base.content.slice(base.content.length-suffixLength),
                encoding:'utf8',bytes:raw.bytes,sha256:raw.sha256};
        }else entry=raw;
        if(!sameKeys(entry,['bytes','content','encoding','sha256'])||typeof entry.content!=='string'||
            !['utf8','base64'].includes(String(entry.encoding))||!Number.isSafeInteger(entry.bytes)||
            Number(entry.bytes)<0||Number(entry.bytes)>EXPANDED_LIMIT||typeof entry.sha256!=='string')return fail();
        const bytes=Buffer.from(entry.content,entry.encoding as 'utf8'|'base64');
        if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256||bytes.toString(entry.encoding as 'utf8'|'base64')!==entry.content||hash(entry)!==ref)return fail();
        visiting.delete(ref);decoded.set(ref,entry);return entry;
    };
    for(const key of Object.keys(pool))decode(key);
    const history:Record<string,unknown>[]=[];let expandedBytes=2;
    for(const raw of packet.sourceHistory){
        const snapshot=object(raw);
        if(!Array.isArray(snapshot.files))return fail();
        const files=snapshot.files.map(rawFile=>{
            const file=object(rawFile),{contentRef,...rest}=file;
            if(Object.hasOwn(file,'content')||typeof contentRef!=='string'||!Object.hasOwn(pool,contentRef))return fail();
            const entry=decode(contentRef);
            if(file.bytes!==entry.bytes||file.encoding!==entry.encoding||file.sha256!==entry.sha256)return fail();
            used.add(contentRef);return {...rest,content:entry.content};
        });
        const expanded:Record<string,unknown>={...snapshot,files}, {recordId,sha256,...body}=expanded;
        if(typeof recordId!=='string'||sha256!==hash(body))return fail();
        expandedBytes+=Buffer.byteLength(JSON.stringify(expanded))+(history.length?1:0);
        if(expandedBytes>EXPANDED_LIMIT)return fail();
        history.push(expanded);
    }
    if(used.size!==Object.keys(pool).length)return fail();
    assertReviewMaterialSafe(history);
    return history;
}

export function expandReviewTestDataPool(packet:Record<string,unknown>):Record<string,unknown>[] {
    if(packet.rawTestDataEncoding===undefined){
        if(packet.rawTestDataPool!==undefined||packet.rawVerifierStdoutEncoding!==undefined||packet.rawVerifierStdoutPool!==undefined||
            packet.rawVerifierPlanTextPool!==undefined||packet.rawVerifierCasePool!==undefined||
            Array.isArray(packet.rawTests)&&packet.rawTests.some(raw=>Object.hasOwn(object(raw),'dataRef')))return fail();
        return expandRawVerifierStdout(packet,Array.isArray(packet.rawTests)?packet.rawTests.map(raw=>object(raw)):[]);
    }
    if(packet.rawTestDataEncoding!=='CONTENT_POOL_V1'||!Array.isArray(packet.rawTests))return fail();
    const pool=object(packet.rawTestDataPool),used=new Set<string>();
    for(const [key,data] of Object.entries(pool)){
        if(!/^[a-f0-9]{64}$/.test(key)||hash(data)!==key)return fail();
    }
    const tests:Record<string,unknown>[]=[];let expandedBytes=2;
    for(const raw of packet.rawTests){
        const test=object(raw);
        if(Object.keys(test).sort().join(',')!=='dataRef,recordId'||typeof test.recordId!=='string'||typeof test.dataRef!=='string'||
            !Object.hasOwn(pool,test.dataRef))return fail();
        const expanded={recordId:test.recordId,data:pool[test.dataRef]};
        expandedBytes+=Buffer.byteLength(JSON.stringify(expanded))+(tests.length?1:0);
        if(expandedBytes>EXPANDED_LIMIT)return fail();
        used.add(test.dataRef);tests.push(expanded);
    }
    if(used.size!==Object.keys(pool).length)return fail();
    const expanded=expandRawVerifierStdout(packet,tests);
    assertReviewMaterialSafe(expanded);
    return expanded;
}

export function assertReviewSourceEncoding(packet:Record<string,unknown>):void {
    if(packet.sourceContentEncoding!==undefined||packet.sourceContentPool!==undefined)expandReviewSourcePool(packet);
    else if(Array.isArray(packet.sourceHistory)&&packet.sourceHistory.some(raw=>{
        const files=object(raw).files;return Array.isArray(files)&&files.some(f=>Object.hasOwn(object(f),'contentRef'));
    }))fail();
    expandReviewTestDataPool(packet);
}
