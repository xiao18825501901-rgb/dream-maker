/**
 * The highest operator request ceiling a binding may declare.
 *
 * This is an OPERATIONAL guard (how many provider calls one binding may spend), not the money ceiling —
 * money is bounded by the authority and the per-request prices. It used to be spelled out separately in
 * NativeOwner's validator, the audit generator and the binding writer, so every owner-authorized raise had
 * to be applied three times and half-applied raises surfaced as NATIVE_OPERATOR_CONFIG_INVALID or a
 * failing operatorBindingsVerified check. One constant, imported everywhere.
 *
 * History: 30 -> 200 -> 300 -> 500 -> 600 -> 700 -> 800 -> 900 -> 1000 -> 1100 -> 1200 -> 1400 -> 1600 -> 1700 -> 1900 -> 2100 -> 2200 -> 2400 -> 2600 -> 2620 -> 2640 -> 1000000.
 * Each raise is recorded under docs/continuation/AUTHORITY_CHANGE_*.md by the owner's standing instruction.
 */
// M76 owner instruction: stop asking for cumulative request increments. This is
// still a fail-closed runaway guard, not a flow-level call allowance; the
// original per-flow calls, repairs, wall-time and money limits remain active.
export const OPERATOR_REQUEST_CEILING = 1_000_000;
