export interface AcceptanceCommand { id: string; command: string[]; setup?: string[][] }

// The approved verifier plan spells a case as {runtime, entry, args}; the executor needs the argv it will
// actually be graded on. Reading `case.command` (which the plan never carries) silently produced
// `command: undefined` for every case, so the injection was a no-op and the model kept guessing flags
// (FINDING_20261030_ORACLE_PLAN_UNSATISFIABLE.md). One argv builder, used by the prompt and testable.
function argv(raw: unknown): string[] | null {
    const c = raw as { entry?: unknown; args?: unknown } | null;
    if (!c || typeof c !== 'object') return null;
    if (typeof c.entry !== 'string' || !c.entry) return null;
    if (!Array.isArray(c.args) || c.args.some(a => typeof a !== 'string')) return null;
    return [c.entry, ...(c.args as string[])];
}

export function acceptanceCommands(plan: unknown): AcceptanceCommand[] | null {
    const cases = (plan as { cases?: unknown } | null)?.cases;
    if (!Array.isArray(cases) || !cases.length) return null;
    const rows: AcceptanceCommand[] = [];
    for (const rawCase of cases) {
        const c = rawCase as { id?: unknown; setup?: unknown } | null;
        const command = argv(c);
        if (!command) continue;
        const setup = Array.isArray(c!.setup) ? c!.setup.map(argv).filter((x): x is string[] => x !== null) : [];
        rows.push({ id: String(c?.id ?? ''), command, ...(setup.length ? { setup } : {}) });
    }
    return rows.length ? rows : null;
}
