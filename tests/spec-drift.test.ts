// Spec-drift check: the field tables in the protocol documents and the JSON Schemas in
// workflows/schemas/ must change together (workflows/schemas/README.md invariant). This
// test extracts field names from the prose tables and fenced JSON blocks and asserts
// two-way agreement with the schemas. When it fails, the offending token is named: fix
// the prose AND the schema in the same change, or extend the normalizer deliberately.
//
// Parsed: workflows/orchestrator-external/protocol.md (wire-type table, envelope blocks)
// and workflows/orchestrator-internal/protocol.md (RESULT contract table, dispatch and
// ledger blocks). The IO doc's EO→IO summary table is intentionally not parsed — the
// external protocol is the wire authority.
//
// Prose notation handled by the normalizer: nested {}[]() (top-level splitting is
// depth- and quote-aware), parenthetical comments, "name: description" prefixes,
// "a + b" and "a or b" alternatives, optional markers ("field?"), array markers ("[]"),
// and the "|" between a specialist's alternative result forms (enum values always sit
// after a "name:" colon and are consumed by the colon rule — tokens that survive with
// unresolvable text fail the test, by design).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import envelopeSchema from "../workflows/schemas/envelope.schema.json" with { type: "json" };
import resultsSchema from "../workflows/schemas/results.schema.json" with { type: "json" };

const ROOT = new URL("../", import.meta.url).pathname;
const read = (p: string) => readFileSync(`${ROOT}${p}`, "utf8");
const external = read("workflows/orchestrator-external/protocol.md");
const internal = read("workflows/orchestrator-internal/protocol.md");

// Phrases with no field-name content in payload cells; extend deliberately, never silently.
const PROSE_PHASES: RegExp[] = [/\bIO treats as new decision point\b/, / — the prompt's verdict lines .*$/];

interface Shape {
	props: string[];
	required: string[];
}

function topSplit(s: string, seps: string): string[] {
	const parts: string[] = [];
	let depth = 0, inQuote = false, cur = "";
	for (const ch of s) {
		if (ch === '"') inQuote = !inQuote;
		if (!inQuote) {
			if ("{[(".includes(ch)) depth++;
			else if ("}])".includes(ch)) depth--;
			else if (depth === 0 && seps.includes(ch)) {
				parts.push(cur); cur = ""; continue;
			}
		}
		cur += ch;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

function fieldNames(cell: string, ctx: string): string[] {
	const clean = PROSE_PHASES.reduce((s, re) => s.replace(re, ""), cell.replace(/\\\|/g, "|"));
	const handle = (raw: string): string[] => {
		let t = raw.trim();
		if (!t) return [];
		if (t.startsWith("{") && t.endsWith("}")) return topSplit(t.slice(1, -1), ",").flatMap((x) => handle(x));
		t = t.replace(/\([^)]*\)/g, "").trim(); // comment parens: "kind (file/log/patch)"
		// name with bracket/brace payload: "findings[{...}]", "handoff{...}", "route?{...}"
		// (optional marker may sit between name and payload) — top level only
		const namePayload = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*[\[{]/);
		if (namePayload) return [namePayload[1]];
		t = t.split(":")[0].trim(); // "outcome: green|unresolved" → "outcome" (enum syntax dies here)
		return t.split(/\s+or\s+/).flatMap((p) =>
			p.split("+")
				.map((f) => f.trim().replace(/\?+$/, "").trim())
				.filter(Boolean)
				.flatMap((name) => {
					if (name.includes(" ")) {
						// qualifier words after a bare field name ("quarantine metadata")
						const first = name.split(" ")[0];
						if (/^[a-z_][0-9a-z_]*$/.test(first)) return [first];
						throw new Error(`unresolvable field token in ${ctx}: "${name}" — fix the prose AND the schema, or extend the normalizer`);
					}
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
						throw new Error(`unresolvable field token in ${ctx}: "${name}" — fix the prose AND the schema, or extend the normalizer`);
					}
					return [name];
				}),
		);
	};
	return topSplit(clean, ",;").flatMap((part) => handle(part));
}

// keys are matched by occurrence, depth-aware: only keys at nesting depth 1 (direct
// children of the block's outer braces) count — values in these blocks never contain
// "key":-shaped text themselves, and nested keys (trace_id, tool_calls, …) are excluded.
function blockKeys(pseudoJson: string): string[] {
	const keys = new Set<string>();
	let depth = 0, inQuote = false, keyStart = -1, afterQuote = -1;
	for (let i = 0; i < pseudoJson.length; i++) {
		const ch = pseudoJson[i];
		if (inQuote) {
			if (ch === '"' && pseudoJson[i - 1] !== "\\") {
				inQuote = false;
				afterQuote = i;
			}
			continue;
		}
		if (ch === '"') {
			inQuote = true;
			if (depth === 1) keyStart = i + 1; else keyStart = -1;
			continue;
		}
		if (ch === ':') {
			if (keyStart !== -1 && pseudoJson.slice(afterQuote + 1, i).trim() === '') {
				keys.add(pseudoJson.slice(keyStart, afterQuote));
				keyStart = -1;
			}
			continue;
		}
		if ("{[".includes(ch)) depth++;
		else if ("}]".includes(ch)) depth--;
	}
	return [...keys];
}

// Table cells are split on UNESCAPED pipes only (cells contain \| inside values, e.g.
// network: "none"\|"proxy"), then unescaped — a regex [^|]* capture would silently
// truncate the payload cell (a false pass), so the row structure is derived from the
// split, not from a pattern that looks through the pipes.
function unescapeCell(cell: string): string {
	return cell.replace(/\\\|/g, "|").trim();
}

function payloadCells(markdown: string, kind: "wire" | "result"): [string, string][] {
	const rows: [string, string][] = [];
	for (const line of markdown.split("\n")) {
		if (!line.startsWith("| `")) continue;
		const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
		const tagMatch = cells[1]?.match(/^`([A-Za-z_]+)`/);
		if (!tagMatch) continue;
		const okCase = kind === "wire" ? /^[A-Z]/.test(tagMatch[1]) : /^[a-z]/.test(tagMatch[1]);
		if (!okCase) continue; 	// each table only feeds its own kind (wire=UPPER, result=lower)
		const payloadCell = kind === "wire" ? cells[4] : cells[2];
		if (payloadCell === undefined) continue;
		rows.push([tagMatch[1], unescapeCell(payloadCell)]);
	}
	return rows;
}

interface EnvelopeClause {
	if?: { properties?: { type?: { const?: string } } };
	then?: { properties?: { payload?: { properties?: object; required?: string[] } } };
}

test("wire-type payloads and the envelope schema agree (two-way)", () => {
	const clauses = (envelopeSchema as { allOf: EnvelopeClause[] }).allOf;
	const schemaPayloads = new Map<string, Shape>();
	for (const clause of clauses) {
		const type = clause.if?.properties?.type?.const;
		if (!type) continue;
		const payload = clause.then?.properties?.payload ?? {};
		schemaPayloads.set(type, { props: Object.keys(payload.properties ?? {}), required: payload.required ?? [] });
	}
	assert.equal(schemaPayloads.size, 14, "envelope schema must cover exactly the 14 wire types (the task_ref/NAK rule clause carries no type const)");
	for (const [type, cell] of payloadCells(external, "wire")) {
		const schema = schemaPayloads.get(type);
		assert.ok(schema, `wire type ${type} has no schema payload clause`);
		const prose = fieldNames(cell, `wire type ${type}`);
		for (const f of prose) assert.ok(schema.props.includes(f), `wire type ${type}: prose field "${f}" missing from schema`);
		for (const f of schema.required) assert.ok(prose.includes(f), `wire type ${type}: schema-required field "${f}" missing from the protocol table`);
	}
});

test("RESULT contract rows and the results schema agree (two-way)", () => {
	const defs = (resultsSchema as { $defs: Record<string, { properties?: object; required?: string[]; oneOf?: { properties?: object; required?: string[] }[] }> }).$defs;
	const defOf = (name: string): Shape => {
		const d = defs[name];
		if (d.oneOf) {
			return {
				props: [...new Set(d.oneOf.flatMap((b) => Object.keys(b.properties ?? {})))],
				required: [...new Set(d.oneOf.flatMap((b) => b.required ?? []))],
			};
		}
		return { props: Object.keys(d.properties ?? {}), required: d.required ?? [] };
	};
	const defMap: Record<string, string> = {
		scout: "scoutResult", plan: "planResult", build: "buildResult",
		test: "testResult", docs: "docsResult", steelman: "steelManResult", contrarian: "contrarianResult",
	};
	for (const [tag, cell] of payloadCells(internal, "result")) {
		assert.ok(defMap[tag], `unexpected specialist tag "${tag}" in the RESULT table`);
		if (tag === "steelman" && cell.includes("contrarian:")) {
			// shared steelman+contrarian row: the "|" between a specialist's forms is form
			// separation, not enum syntax — split it here, then fieldNames each form;
			// "PROTOCOL INVALID" etc. normalize to the verdict-field names.
			const [steelCell, contraCell] = cell.split(/\s*contrarian:\s*/);
			const steel = fieldNames(steelCell.replace(/^steelman:\s*/, "").split("|").join(","), "steelman");
			const contra = fieldNames(contraCell, "contrarian");
			for (const [prose, def, who] of [
				[steel, defOf("steelManResult"), "steelman"],
				[contra, defOf("contrarianResult"), "contrarian"],
			] as [string[], Shape, string][]) {
				for (const f of prose) assert.ok(def.props.includes(f), `${who}: prose field "${f}" missing from schema`);
				for (const f of def.required) assert.ok(prose.includes(f), `${who}: schema-required field "${f}" missing from the protocol table`);
			}
			continue;
		}
		const def = defOf(defMap[tag]);
		const prose = fieldNames(cell, `result ${tag}`);
		for (const f of prose) assert.ok(def.props.includes(f), `result ${tag}: prose field "${f}" missing from schema`);
		for (const f of def.required) assert.ok(prose.includes(f), `result ${tag}: schema-required field "${f}" missing from the protocol table`);
	}
});

test("fenced JSON blocks match the schema shapes they document", () => {
	const blocks = [...`${external}\n${internal}`.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
	const envSchema = envelopeSchema as { properties: Record<string, unknown> };
	const envelopeKeys = [...new Set(blocks.filter((b) => /"v"\s*:|"trace"\s*:/.test(b)).flatMap(blockKeys))].sort();
	assert.deepEqual(envelopeKeys, Object.keys(envSchema.properties).sort());

	const defs = (resultsSchema as { $defs: Record<string, { properties: object; required: string[] }> }).$defs;
	const keysOf = (defName: string) => [...new Set([...Object.keys(defs[defName].properties), ...defs[defName].required])].sort();
	const dispatchBlock = blocks.find((b) => b.includes('"dispatch_id"'));
	assert.ok(dispatchBlock, "dispatch record block not found");
	assert.deepEqual(blockKeys(dispatchBlock).sort(), keysOf("dispatch"));
	const ledgerBlock = blocks.find((b) => b.includes('"seq"'));
	assert.ok(ledgerBlock, "ledger entry block not found");
	assert.deepEqual(blockKeys(ledgerBlock).sort(), keysOf("ledgerEntry"));
});