export class GuardError extends Error { code: string; status: number; constructor(code: string,status?: number) }
export function digest(value: unknown): string;
export function canonicalJson(value: unknown): string;
