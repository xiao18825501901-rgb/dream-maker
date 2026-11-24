import type { ResearchRun, SourceSnapshot } from '../../shared/research.js';
import type { PublicRepositoryClient } from './repository-clients.mjs';
export class RepositoryResearchService {
    constructor(options: {clients: PublicRepositoryClient[];now?: ()=>number});
    discover(input: {keywords: string[];disclosure: {kind: 'PUBLIC_GENERIC_TERMS_ONLY';queryHash: string;intentHash: string};intentHash: string;maxCandidates?: number;signal?: AbortSignal}): Promise<ResearchRun>;
}
export function verifySnapshot(snapshot: unknown): SourceSnapshot;
export function evaluateReuse(snapshot: SourceSnapshot, assessment: unknown, context: {requirementIds:string[];intentHash:string;distribution:string}, options?: {verifyAssessment?:(value:unknown)=>boolean;now?:number}): {eligible:boolean;status:string;reasons:string[];score:number|null};
