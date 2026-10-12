// Binding-artifact validator — the executable form of workflows/bindings.md §Validator.
//
// Trust-critical checks, deterministic (model-judgment-free): git roles must be
// remoteless (sandbox agents never touch remotes — README §Version control conventions),
// gated roles must map to enforcement mechanisms (capability-not-dispatched, never
// prompt text — EO design §Security boundary rules), per-dispatch budgets and per-role
// timeouts must sit inside the EO-protocol §Timeouts defaults.
//
// Consumes a ALREADY-PARSED binding document (the bindings file is YAML — parsing is a
// harness concern; loaders may use js-yaml or equivalent. This module stays dependency-
// free, mirroring shared/wire.ts). Also accepts JSON-parsed documents.
//
// Failures are configuration failures, not runtime fallbacks (bindings.md §Required
// properties 1).

export type BindingCheck = { ok: true } | { ok: false; errors: string[] };
export type BindingRole = { command?: string; tool?: string; tools?: string[]; timeout_s?: number; gate?: { mechanism?: string; scope?: string }; remote?: unknown; env?: Record<string, unknown>; note?: string };
export type BindingAgent = { roles?: Record<string, BindingRole>; gates?: Record<string, { mechanism?: string; scope?: string } | { mechanism?: string; scope?: string }[]>; budgets?: { per_dispatch?: { tool_calls?: number; seconds?: number } }; notes?: string[] };

// EO-protocol §Timeouts defaults (single authority): dispatch wall clock / tool calls,
// plus per-role execution defaults (build execution 15 min, suite 30 min).
export const DEFAULT_DISPATCH = { tool_calls: 15, seconds: 300 };
export const DEFAULT_ROLE_TIMEOUT_S: Record<string, number> = {
	"run-build": 900,      // build execution default: 15 min
	"run-suite": 1800,     // test-suite execution default: 30 min
	"run-check": 300, "run-test": 300, "docs-check": 300,
	"git-commit": 300, "git-info": 300, "env-check": 60,
};

const GATE_MECHANISMS = ["approval", "allowlist", "disabled"];
const GIT_ROLE = /^git/;

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate one agent's binding block. `textOnly` agents (steelman, contrarian) must
 * carry no workspace tools (adversarial design §Deployment model).
 */
export function validateAgentBinding(name: string, agent: BindingAgent): BindingCheck {
	const errors: string[] = [];
	if (!isObj(agent)) return { ok: false, errors: [`${name}: agent block must be an object`] };
	const roles = agent.roles ?? {};
	if (!isObj(roles)) return { ok: false, errors: [`${name}: roles must be an object`] };

	const textOnly = name === "steelman" || name === "contrarian";
	if (textOnly && Object.keys(roles).length > 0) {
		errors.push(`${name}: text-in/text-out gate agents must bind no roles (got ${Object.keys(roles).join(", ")})`);
	}

	for (const [role, r] of Object.entries(roles)) {
		// git remotelessness — the enforcement behind "sandbox agents never touch remotes"
		if (GIT_ROLE.test(role) && !("remote" in r) ) {
			errors.push(`${name}.${role}: git role MUST declare remote: null explicitly`);
		} else if (GIT_ROLE.test(role) && "remote" in r && r.remote !== null) {
			errors.push(`${name}.${role}: remote must be null (sandbox agents never touch remotes); got ${JSON.stringify(r.remote)}`);
		}
		// timeouts may only tighten the protocol defaults
		if (r.timeout_s !== undefined) {
			const def = DEFAULT_ROLE_TIMEOUT_S[role];
			if (def === undefined) errors.push(`${name}.${role}: timeout_s given for a role with no protocol default`);
			else if (typeof r.timeout_s !== "number" || r.timeout_s > def)
				errors.push(`${name}.${role}: timeout_s ${r.timeout_s} exceeds the ${role} default of ${def} s — bindings may only tighten (EO-protocol §Timeouts)`);
		}
	}

	// gate mechanisms: every declared gate must be a real mechanism, never prose
	for (const [target, gRaw] of Object.entries(agent.gates ?? {})) {
		const g = gRaw as unknown;
		const list = Array.isArray((g as unknown)) ? g : [g as { mechanism?: string }];
		const gate = (Array.isArray(g) ? g[0] : g) as { mechanism?: string };
		{
			if (!isObj(gate) || !GATE_MECHANISMS.includes(String(gate.mechanism))) {
				errors.push(`${name}: gate for "${target}" must use mechanism ${GATE_MECHANISMS.join("|")} — prose gates are not enforcement (got ${JSON.stringify(gate)})`);
			}
		}
	}
	// harnesses without gate plugins: bindings.md §2 requires gated roles to be marked
	// `disabled` there; an `approval` gate on a role whose harness lacks the capability
	// channel is a harness-provisioning event, not a validator failure — the capability is
	// simply not dispatched (EO design §5). No check by design.

	// budgets: per-dispatch values must sit inside the protocol defaults
	const per = agent.budgets?.per_dispatch ?? {};
	if (per.tool_calls !== undefined && per.tool_calls > DEFAULT_DISPATCH.tool_calls)
		errors.push(`${name}: budgets.per_dispatch.tool_calls ${per.tool_calls} > protocol default ${DEFAULT_DISPATCH.tool_calls}`);
	if (per.seconds !== undefined && per.seconds > DEFAULT_DISPATCH.seconds)
		errors.push(`${name}: budgets.per_dispatch.seconds ${per.seconds} > protocol default ${DEFAULT_DISPATCH.seconds}`);
	return errors.length ? { ok: false, errors } : { ok: true };
}

/** Validate a whole binding document: `{ harness, agents: {<name>: block} }`. */
export function validateBindingDocument(doc: unknown): BindingCheck {
	if (!isObj(doc)) return { ok: false, errors: ["binding document must be an object"] };
	const agents = doc.agents;
	if (!isObj(agents) || Object.keys(agents).length === 0)
		return { ok: false, errors: ["binding document must declare at least one agent under `agents`"] };
	const all: string[] = [];
	for (const [name, agent] of Object.entries(agents)) {
		const res = validateAgentBinding(name, agent as BindingAgent);
		if (!res.ok) all.push(...res.errors);
	}
	if (typeof doc.harness !== "string" || !doc.harness) all.push("binding document must declare `harness`");
	return all.length ? { ok: false, errors: all } : { ok: true };
}