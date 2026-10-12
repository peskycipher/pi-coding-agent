import assert from "node:assert/strict";
import { test } from "node:test";

import { validateAgentBinding, validateBindingDocument } from "../shared/bindings.ts";

test("git roles are remoteless: enforced exactly, not assumed", () => {
	const base = { budgets: { per_dispatch: { tool_calls: 15, seconds: 300 } }, roles: {} };
	const withExplicitNull = validateAgentBinding("build", {
		...base, roles: { "git-commit": { command: "git commit -m m", remote: null } },
	});
	assert.ok(withExplicitNull.ok);

	const missingRemote = validateAgentBinding("build", {
		...base, roles: { "git-commit": { command: "git commit -m m" } },
	});
	assert.ok(!missingRemote.ok);
	assert.ok(missingRemote.errors[0].includes("MUST declare remote: null"));

	const withRemote = validateAgentBinding("build", {
		...base, roles: { "git-commit": { command: "git push", remote: "origin" } },
	});
	assert.ok(!withRemote.ok);
	assert.ok(withRemote.errors[0].includes("must be null"));
});

test("gates are mechanisms, never prose", () => {
	const proseGate = validateAgentBinding("build", {
		roles: {}, gates: { "install-deps": "only declared versions, promised" } as never,
	});
	assert.ok(!proseGate.ok);
	assert.ok(proseGate.errors[0].includes("prose gates are not enforcement"));

	const valid = validateAgentBinding("build", {
		roles: {}, gates: { "install-deps": { mechanism: "approval", scope: "manifest" } },
	});
	assert.ok(valid.ok);
});

test("budgets and timeouts may only tighten the protocol defaults", () => {
	const over = validateAgentBinding("scout", {
		roles: {}, budgets: { per_dispatch: { tool_calls: 40, seconds: 600 } },
	});
	assert.ok(!over.ok);
	assert.equal(over.errors.length, 2);

	const tight = validateAgentBinding("scout", {
		roles: { "run-check": { command: "npx jest -t x", timeout_s: 120 } }, budgets: { per_dispatch: { tool_calls: 10, seconds: 300 } },
	});
	assert.ok(tight.ok);

	const loosened = validateAgentBinding("build", {
		roles: { "run-build": { command: "make", timeout_s: 1800 } },
	});
	assert.ok(!loosened.ok);
	assert.ok(loosened.errors[0].includes("1800"));
});

test("text-only gate agents bind no workspace tools", () => {
	assert.ok(validateAgentBinding("contrarian", { roles: {} }).ok);
	const withTools = validateAgentBinding("steelman", {
		roles: { "workspace-read": { tools: ["read"] } },
	});
	assert.ok(!withTools.ok);
	assert.ok(withTools.errors[0].includes("must bind no roles"));
});

test("document-level validation: harness declared, agents present, all errors aggregated", () => {
	const bad = validateBindingDocument({
		harness: "ci",
		agents: {
			scout: { roles: { "git-info": { command: "git log", remote: "origin" } } },
			build: { roles: {}, gates: { "workspace-edit": { mechanism: "maybe" } } },
		},
	});
	assert.ok(!bad.ok);
	assert.equal(bad.errors.length, 2); // 1 remote error + 1 prose-gate error

	assert.ok(validateBindingDocument({ harness: "ci", agents: { scout: { roles: { "git-info": { remote: null } } } } }).ok);
	assert.ok(!validateBindingDocument({ agents: {} }).ok, "empty agents rejected");
});