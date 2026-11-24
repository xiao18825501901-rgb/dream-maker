import { DomainError, hash, object } from './security.js';
import type { AgentInput } from '../shared/types.js';
import { assertReviewMaterialSafe } from './review-material.js';
import {assertReviewSourceEncoding} from './review-source-pool.js';
import {parseGatewayJson} from './gateway-tool-arguments.js';

function admissionPlannerSession(execution:Record<string,unknown>,reviewerSession:string,specHash:string,fail:()=>never):string{
    const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail();
    const nonEmpty=(value:unknown):value is string=>typeof value==='string'&&!!value;
    const identities=record(execution.roleIdentities??{});
    if(identities.planner2!==undefined){
        const identity=record(identities.planner2),sessionId=identity.sessionId;
        if(!nonEmpty(sessionId)||sessionId===reviewerSession)return fail();
        return sessionId;
    }

    // Documentation continuations deliberately do not manufacture a current
    // P2 AgentSession. Accept only the exact identity preserved from the
    // independently reviewed parent packet.
    const inherited=record(execution.inheritedPlanning??{});
    if(inherited.schema!=='dream-maker.inherited-planning-evidence.v1'||inherited.origin!=='INHERITED_NOT_NEW_PLANNING'||
        !nonEmpty(inherited.parentRunId))return fail();
    const planner=record(inherited.planner),identity=record(planner.identity),session=record(planner.session),data=record(session.data),
        parent=record(inherited.packet),reviewedPacket=record(parent.packet),reviewedExecution=record(reviewedPacket.executionEvidence),
        reviewedIdentity=record(record(reviewedExecution.roleIdentities).planner2);
    if(reviewedPacket.schema!=='dream-maker.review-packet.v1'||reviewedPacket.runId!==inherited.parentRunId||
        reviewedPacket.specHash!==specHash||hash(identity)!==hash(reviewedIdentity))return fail();
    const sessionId=identity.sessionId;
    if(!nonEmpty(sessionId)||sessionId===reviewerSession||!nonEmpty(identity.requestId)||
        !nonEmpty(session.recordId)||session.kind!=='AgentSession'||data.role!=='planner2'||
        data.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||
        !['runner','provider','authentication','model','sessionId'].every(key=>data[key]===identity[key]))return fail();
    return sessionId;
}

/** Scan the same complete task body at preparation and actual admission. */
export function assertReviewTaskBodySafe(body:Record<string,unknown>):void{
    let parsedPacket:Record<string,unknown>|undefined;
    if(body.schema==='dream-maker.review-packet.v1'){parsedPacket=body;assertReviewSourceEncoding(body);}
    else if(typeof body.taskData==='string'){
        let packet:unknown;try{packet=JSON.parse(body.taskData);}catch{}
        if(packet&&typeof packet==='object'&&!Array.isArray(packet)){
            // Preserve the original wire long enough to reject duplicate and
            // escaped-alias keys before JSON.parse can discard a definition.
            parseGatewayJson(body.taskData,()=>{});
            assertReviewSourceEncoding(packet as Record<string,unknown>);
            parsedPacket=packet as Record<string,unknown>;
        }
    }
    if(body.schema==='dream-maker.review-packet.v1')assertReviewMaterialSafe(body);
    else{
        assertReviewMaterialSafe(parsedPacket??body.taskData);
        assertReviewMaterialSafe(JSON.stringify({...body,taskData:null}));
    }
}

/** Added only after the real app-server acknowledged the controller's read-only profile.
 * It proves admission of this session, never completion or a review verdict. */
export function reviewAdmissionPrompt(input:Pick<AgentInput,'role'|'runId'|'specHash'|'prompt'>,admission:{threadId:string;model:string;provider:string;permissionProfile:string;policyHash:string;authentication?:'API_KEY'|'CHATGPT_SUBSCRIPTION';materialEncoding?:'PACKET_OBJECT_V1'}) {
    if(admission.materialEncoding!==undefined&&admission.materialEncoding!=='PACKET_OBJECT_V1')throw new DomainError('REVIEW_ADMISSION_BINDING_INVALID',409);
    if(input.role!=='reviewer')return {prompt:input.prompt};
    let body:Record<string,unknown>,packet:Record<string,unknown>;
    try{
        body=object(JSON.parse(input.prompt));
        packet=body.schema==='dream-maker.review-packet.v1'?body:object(JSON.parse(String(body.taskData)));
    }catch{return {prompt:input.prompt};}
    if(packet.schema!=='dream-maker.review-packet.v1')return {prompt:input.prompt};
    parseGatewayJson(input.prompt,()=>{});
    const fail=():never=>{throw new DomainError('REVIEW_ADMISSION_BINDING_INVALID',409);};
    if(body.controllerAdmission!==undefined||packet.controllerAdmission!==undefined||body.specHash!==input.specHash||
        packet.runId!==input.runId||packet.specHash!==input.specHash)return fail();
    const execution=object(packet.executionEvidence??{});
    const plannerSession=admissionPlannerSession(execution,admission.threadId,input.specHash,fail);
    if(!plannerSession)return fail();
    if(Array.isArray(execution.sessions)&&execution.sessions.some(row=>{
        const data=object(object(row).data);return data.role==='planner2'&&data.sessionId===admission.threadId;
    }))return fail();
    const {authentication='CHATGPT_SUBSCRIPTION',...binding}=admission;
    if(authentication!=='API_KEY'&&authentication!=='CHATGPT_SUBSCRIPTION'||authentication==='CHATGPT_SUBSCRIPTION'&&binding.provider!=='openai')return fail();
    const packetHash=hash(packet),controllerAdmission={schema:'dream-maker.review-admission.v1',status:'ADMITTED_NOT_COMPLETED',
        role:'reviewer',runId:input.runId,specHash:input.specHash,packetHash,...binding,
        authentication,paidFallback:false,toolsAllowed:false};
    // One transport layer may carry the exact packet as a JSON object. Do not
    // decode source/log strings inside it or drop carrier fields. Absent encoding
    // retains the old bytes for historical transcript reconciliation.
    const carrier=admission.materialEncoding==='PACKET_OBJECT_V1'&&body.schema!=='dream-maker.review-packet.v1'?{...body,taskData:packet}:body;
    const prompt=JSON.stringify({...carrier,controllerAdmission});
    // Keep the original scanner and the exact transmitted material. Scan the
    // serialized packet and its carrier separately so transport escaping does
    // not multiply the packet's decode budget. Carrier fields stay serialized,
    // preserving detection of escaped keys as well as escaped values.
    assertReviewTaskBodySafe({...body,controllerAdmission});
    return {prompt,packetHash};
}
