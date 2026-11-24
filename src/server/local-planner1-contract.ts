export const LOCAL_PLANNER1_BASE_URL = 'http://127.0.0.1:11434/v1';
export const LOCAL_PLANNER1_PROTOCOL = 'chat-completions';
export const LOCAL_PLANNER1_KEY_ENV = 'DM_LOCAL_PLANNER1_NO_KEY';
export const LOCAL_PLANNER1_MODEL_PATHS = ['/v1/models', '/v1/chat/completions'] as const;
export const LOCAL_PLANNER1_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

export const LOCAL_PLANNER1_CANDIDATES = Object.freeze([
    {
        model: 'qwen2.5:7b',
        label: 'Qwen2.5 7B（推荐，4.7 GB 下载）',
        license: 'Apache-2.0',
        source: 'https://ollama.com/library/qwen2.5:7b',
        minimumTotalMemoryMiB: 16 * 1024,
        minimumAvailableMemoryMiB: 8 * 1024,
        minimumCpuCores: 4
    },
    {
        model: 'qwen2.5:3b',
        label: 'Qwen2.5 3B（轻量，1.9 GB 下载）',
        license: 'Qwen-license',
        source: 'https://ollama.com/library/qwen2.5:3b',
        minimumTotalMemoryMiB: 8 * 1024,
        minimumAvailableMemoryMiB: 4 * 1024,
        minimumCpuCores: 2
    }
] as const);

export type LocalPlanner1Candidate = typeof LOCAL_PLANNER1_CANDIDATES[number];
