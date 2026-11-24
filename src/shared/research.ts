export type SourcePlatform = 'github' | 'gitlab';
export interface RepositoryRef { platform: SourcePlatform; namespace: string; webUrl: string }
export interface SourceFile {
    path: string; content: string; contentSha256: string; bytes: number; ref: string; url: string;
    retrievedAt: string; trust: 'UNTRUSTED_REPOSITORY_DATA'; gitBlobId: string; gitMode: '100644' | '100755';
}
export interface SourceSnapshot extends RepositoryRef {
    commit: string; sourceId: string; files: SourceFile[]; failures: {path: string;code: string}[];
    snapshotHash: string; archived: boolean; disabled: boolean; retrievedAt: string;
    discoveredLicenseHint: string | null; description: string; evidenceLevel: 'PINNED_TEXT_ONLY_NOT_EXECUTED';
}
export interface SearchResult {
    platform: SourcePlatform; items: (RepositoryRef & {description: string;archived: boolean;sourceId: string;discoveredAt: string;evidenceLevel: 'DISCOVERED_ONLY'})[];
    retrievedAt: string; incomplete: boolean; scope: 'BOUNDED_PUBLIC_SEARCH_NOT_EXHAUSTIVE';
}
export interface ResearchRun {
    schema: 'dream-maker.research-run.v1'; intentHash: string; queriedAt: string;
    status: 'UNAVAILABLE' | 'PARTIAL' | 'SEARCHED_WITHIN_BOUNDS';
    searchScope: 'PUBLIC_KEYWORDS_ONLY_BOUNDED_NOT_EXHAUSTIVE'; results: SearchResult[];
    failures: {platform: SourcePlatform;stage: 'INSPECT' | 'SEARCH';code: string}[];
    snapshots: SourceSnapshot[]; candidateTextTrust: 'UNTRUSTED_DATA_NEVER_INSTRUCTIONS'; executedSourceCode: false;
}
export type ResearchReceipt = Omit<ResearchRun,'snapshots'> & {snapshots: Omit<SourceSnapshot,'files'>[]};
export interface ResearchOperation {
    id: string; projectId: string; projectVersion: number; inputHash: string; keywords: string[];
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'RESULT_UNCERTAIN';
    requestCount: number; at: string; code?: string; result?: ResearchReceipt;
}
