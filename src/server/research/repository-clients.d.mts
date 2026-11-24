import type { RepositoryRef, SourcePlatform, SourceSnapshot, SearchResult } from '../../shared/research.js';
import type { ResearchTransport } from './transport.js';
export class ResearchNetwork {
    constructor(options?: { transport?: ResearchTransport; maxRequests?: number; timeoutMs?: number; now?: ()=>number });
    readonly usedRequests: number;
}
export class PublicRepositoryClient {
    platform: SourcePlatform;
    constructor(platform: SourcePlatform,network?: ResearchNetwork);
    search(keywords: string[],options?: {signal?: AbortSignal;limit?: number}): Promise<SearchResult>;
    inspect(ref: RepositoryRef,options?: {signal?: AbortSignal;filePaths?: string[]}): Promise<SourceSnapshot>;
}
export function safeSearchKeywords(keywords: unknown): string[];
