export type CustomMagpieProtocol = 'chat-completions' | 'openai-responses' | 'anthropic-messages';

export function officialCliResponsesRole(role: string, runtime: string): boolean {
    return (role === 'planner2' || role === 'reviewer') && (runtime === 'opencode' || runtime === 'cline');
}

/** A read-only official CLI may speak the native Messages wire instead of Chat or Responses. */
export function officialCliMessagesRole(role: string, runtime: string): boolean {
    return (role === 'planner2' || role === 'reviewer') && (runtime === 'opencode' || runtime === 'cline');
}

export function claudeTranslatedProtocol(role:string,runtime:string,protocols:readonly string[]):'chat-completions'|'openai-responses'|undefined {
    if (runtime !== 'claude' || (role !== 'planner2' && role !== 'reviewer') || protocols.includes('anthropic-messages')) return;
    if (protocols.includes('chat-completions')) return 'chat-completions';
    if (protocols.includes('openai-responses')) return 'openai-responses';
}

/** The Claude Code CLI is the fourth executor leg, and the second one whose tools are its own.
 * A model that declares the Messages wire keeps it — that is the CLI's own wire and the only one
 * it speaks without a proxy. A model that declares only an OpenAI wire is served by the product
 * gateway's executor translation (flow/cli-executor-wire.ts), which rebuilds every tool round trip
 * in the CLI's own Messages dialect; the same ladder the DSH executor already follows, and for the
 * same reason: Responses wins when the model declares it, Chat is the fallback. */
export function claudeExecutorProtocol(role:string,runtime:string,protocols:readonly string[]):'anthropic-messages'|'openai-responses'|'chat-completions'|undefined {
    if (role !== 'executor' || runtime !== 'claude') return;
    if (protocols.includes('anthropic-messages')) return 'anthropic-messages';
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('chat-completions')) return 'chat-completions';
}

/** OpenCode and Cline are the same executor shape as Claude Code: the harness's own edit and
 * shell tools, translated onto whichever OpenAI wire the model declares when it declares no
 * Messages one. Each harness keeps its own function so a lane can never answer for another. */
export function opencodeExecutorProtocol(role:string,runtime:string,protocols:readonly string[]):'anthropic-messages'|'openai-responses'|'chat-completions'|undefined {
    if (role !== 'executor' || runtime !== 'opencode') return;
    if (protocols.includes('anthropic-messages')) return 'anthropic-messages';
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('chat-completions')) return 'chat-completions';
}

export function clineExecutorProtocol(role:string,runtime:string,protocols:readonly string[]):'anthropic-messages'|'openai-responses'|'chat-completions'|undefined {
    if (role !== 'executor' || runtime !== 'cline') return;
    if (protocols.includes('anthropic-messages')) return 'anthropic-messages';
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('chat-completions')) return 'chat-completions';
}

/** Codex is the one CLI executor whose own tools ride the Responses wire: the CLI reads
 * Responses locally, so a declared Responses wire stays a native passthrough. A model that
 * declares only Chat is served by the same translation, which hands the CLI rebuilt
 * ResponseItems instead of raw upstream frames. A model that declares neither is served by the
 * third outlet of the same leg: the executor body is rendered in the Anthropic dialect, its tools
 * as input_schema declarations and its call history as assistant tool_use / user tool_result
 * blocks, and the answer is rebuilt as the function_call items the CLI reads. That outlet is last
 * for the same reason the other two keep their order: every wire above it is a shape this product
 * already proved end to end, and the Messages transcript is the one it authors itself. */
export function codexExecutorProtocol(role:string,runtime:string,protocols:readonly string[]):'openai-responses'|'chat-completions'|'anthropic-messages'|undefined {
    if (role !== 'executor' || runtime !== 'codex') return;
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('chat-completions')) return 'chat-completions';
    if (protocols.includes('anthropic-messages')) return 'anthropic-messages';
}

/** A DSH supervisor keeps the native Messages wire when its model advertises one. Otherwise the
 * product gateway translates the frozen single-terminal-tool turn onto Responses or Chat; the Go
 * ingress admits exactly the role's one terminal tool on both wires. */
export function dshSupervisorProtocol(role:string,runtime:string,protocols:readonly string[]):'openai-responses'|'chat-completions'|undefined {
    if (runtime !== 'dsh' || (role !== 'planner2' && role !== 'reviewer') || protocols.includes('anthropic-messages')) return;
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('chat-completions')) return 'chat-completions';
}

/** A DSH executor keeps the native Messages wire when its model advertises one. Otherwise the
 * product gateway translates the whole tool round trip onto Responses or Chat: the executor
 * declares up to eight functions, answers every tool_use with a tool_result, and repeats until it
 * answers in text, which is exactly the tool shape both OpenAI wires already speak. Responses wins
 * when the model declares it, matching the DSH supervisor lane; Chat is the fallback and a model
 * that declares only Chat never reaches the Responses outlet. */
export function dshExecutorProtocol(role:string,runtime:string,protocols:readonly string[]):'openai-responses'|'chat-completions'|undefined {
    if (runtime !== 'dsh' || role !== 'executor' || protocols.includes('anthropic-messages')) return;
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('chat-completions')) return 'chat-completions';
}

/** A read-only Codex role whose selected model declares only the native Messages wire is served
 * by the product gateway's Responses-to-Messages translation. A model that also advertises the
 * Responses wire keeps the reviewed ladder in magpie-route.additionalMagpieRoute, so the resolved
 * preference stays responses > chat > messages and every gated wire keeps its own digest gate. */
export function codexTranslatedProtocol(role:string,runtime:string,protocols:readonly string[]):'anthropic-messages'|undefined {
    if (role !== 'planner2' && role !== 'reviewer') return;
    if (runtime !== 'codex' || protocols.includes('openai-responses')) return;
    if (protocols.includes('anthropic-messages')) return 'anthropic-messages';
}

export function piExecutorToolProtocol(role:string,runtime:string,protocols:readonly string[]):'openai-responses'|'anthropic-messages'|undefined {
    if (role !== 'executor' || runtime !== 'pi') return;
    if (protocols.includes('openai-responses')) return 'openai-responses';
    if (protocols.includes('anthropic-messages')) return 'anthropic-messages';
}

/** A read-only Pi role keeps Pi's own native Responses wire, and only that wire.
 *
 *  Pi is the one harness whose reply validator admits exactly one text block or one tool call, so
 *  a Pi turn is never served by a dialect this product authors: the wire the model declares is the
 *  wire the CLI speaks. The executor leg above prefers Responses and falls back to Messages; a
 *  read-only leg has no second wire, because a supervision answer is a single text turn and the two
 *  read-only desk tools are ordinary function declarations on that same Responses shape.
 *
 *  This selector names a wire; it opens nothing. flow/pi-native-wire.ts holds the tool set,
 *  magpie-route.piReadOnlyBuilds holds the reviewed build digest, and an empty set is a closed lane:
 *  additionalMagpieRoute still names the outlet so every caller fails its own build gate instead of
 *  falling back to Pi's executor leg, DSH or Codex. */
export function piReadOnlyToolProtocol(role:string,runtime:string,protocols:readonly string[]):'openai-responses'|undefined {
    if (runtime !== 'pi' || (role !== 'planner2' && role !== 'reviewer')) return;
    if (protocols.includes('openai-responses')) return 'openai-responses';
}

/** Preferred wire for an API-key role, using the advertised protocols of one model.
 *
 *  This function is also the authoritative statement of which harnesses can be executors.
 *  Six legs exist: piExecutorToolProtocol and dshExecutorProtocol (both translated from the start),
 *  and the four CLI legs claudeExecutorProtocol, opencodeExecutorProtocol, clineExecutorProtocol,
 *  codexExecutorProtocol. A CLI leg keeps its harness's own wire when the model declares it and
 *  otherwise falls back to the same translated ladder, behind a second, separate digest set so a
 *  translated outlet never borrows the native lane's evidence. Every other helper is
 *  planner2/reviewer-only by its own first guard. Adding an executor harness therefore
 *  means adding a leg here AND a reviewed-build digest in magpie-route.ts, which that file allows
 *  only after a physical end-to-end turn against the exact binary. tests/revamp/cli-executor-boundary
 *  locks the current matrix so a role switch alone can never appear to open a lane. */
export function customMagpieProtocol(role: 'planner2' | 'executor' | 'reviewer', runtime: string, protocols: readonly string[]): CustomMagpieProtocol | undefined {
    if (runtime === 'codex' && role !== 'executor' && protocols.includes('openai-responses')) return 'openai-responses';
    if (runtime === 'dsh' || (runtime === 'claude' && role !== 'executor')) {
        return protocols.includes('anthropic-messages') ? 'anthropic-messages' : undefined;
    }
    // Claude as an executor follows the same ladder as DSH's: the CLI's own Messages wire first,
    // then the two translated OpenAI outlets.
    if (runtime === 'claude' && role === 'executor') return claudeExecutorProtocol(role,runtime,protocols);
    // OpenCode and Cline are the same executor shape as Claude Code, and Codex is the Responses
    // one. Each keeps its own function so a lane can never answer for another harness.
    if (role === 'executor' && (runtime === 'opencode' || runtime === 'cline'))
        return runtime === 'opencode' ? opencodeExecutorProtocol(role,runtime,protocols) : clineExecutorProtocol(role,runtime,protocols);
    if (role === 'executor' && runtime === 'codex') return codexExecutorProtocol(role,runtime,protocols);
    // A read-only Pi role is deliberately NOT resolved here. Its one wire is decided by
    // piReadOnlyToolProtocol and gated by magpie-route.piReadOnlyBuilds inside
    // additionalMagpieRoute, so an unregistered build fails the route instead of producing a
    // protocol this ladder would then have to trust. The executor arm below is Chat for Pi.
    const usesChat = role === 'executor' ? runtime === 'pi' : ['codex', 'opencode', 'cline', 'independent'].includes(runtime);
    if (usesChat && protocols.includes('chat-completions')) return 'chat-completions';
    // A Codex role reads Responses locally, so each upstream shape it can use is a translated
    // lane with its own digest gate. The Chat outlet is already verified end to end; the
    // Messages translation still waits for its build digest, so it is chosen last and only for
    // a model that declares neither Responses nor Chat.
    const codex = codexTranslatedProtocol(role,runtime,protocols);
    if (codex) return codex;
    // A frozen read role whose model advertises only the native Messages wire keeps that wire.
    // A model that also advertises Responses is left to the reviewed-build ladder in
    // magpie-route.additionalMagpieRoute, so the resolved order stays responses > messages > chat
    // and every gated wire keeps its own digest gate.
    if (role !== 'executor' && officialCliMessagesRole(role, runtime) &&
        !protocols.includes('openai-responses') && protocols.includes('anthropic-messages')) return 'anthropic-messages';
}
