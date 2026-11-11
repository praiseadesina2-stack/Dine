/**
 * Keeps contracts/schemas in step with the code: enums match the value lists the
 * recommender uses, and the tools the agent declares match the contract's argument schemas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AVOIDABLE_PREPS, CRAVINGS, DAYS, GOALS } from "./recommend/types.js";
import { ALLERGENS } from "./recommend/knowledge.js";
import { FINAL_ANSWER, reviewToolDeclarations, toolDeclarations } from "./find/tools.js";

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/schemas");
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), "utf8"));
const sorted = (xs: readonly string[]) => [...xs].sort();

test("every schema file is valid JSON with a title or $defs", () => {
  const files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6, `expected the schema files, found ${files.join(", ")}`);
  for (const f of files) {
    const s = load(f);
    assert.ok(s.title || s.$defs, `${f} has neither title nor $defs`);
  }
});

test("PreferenceProfile enums match the recommender's codes", () => {
  const p = load("preference-profile.schema.json").properties;
  const defs = load("preference-profile.schema.json").$defs;
  assert.deepEqual(sorted(p.goals.items.enum), sorted(GOALS));
  assert.deepEqual(sorted(p.cravings.items.enum), sorted(CRAVINGS));
  assert.deepEqual(sorted(p.avoid_ingredients.items.enum), sorted(ALLERGENS));
  assert.deepEqual(sorted(p.avoid_preps.items.enum), sorted(AVOIDABLE_PREPS));
  assert.deepEqual(sorted(defs.day.enum), sorted(DAYS));
});

test("PlanProposal day codes match DAYS", () => {
  assert.deepEqual(sorted(load("plan-proposal.schema.json").$defs.item.properties.day.enum), sorted(DAYS));
});

test("ChatReply matches the final_answer declaration", () => {
  const decl = toolDeclarations.find((d) => d.name === FINAL_ANSWER)!.parametersJsonSchema as any;
  const schema = load("chat-reply.schema.json");
  assert.deepEqual(sorted(decl.required), sorted(schema.required));
  assert.equal(decl.properties.picks.maxItems, schema.properties.picks.maxItems);
  const declPick = decl.properties.picks.items;
  const schemaPick = schema.properties.picks.items;
  assert.deepEqual(sorted(Object.keys(declPick.properties)), sorted(Object.keys(schemaPick.properties)));
  assert.deepEqual(sorted(declPick.required), sorted(schemaPick.required));
});

test("every declared read tool has a contract schema covering its arguments", () => {
  const defs = load("tool-args.schema.json").$defs;
  for (const d of [...toolDeclarations, ...reviewToolDeclarations]) {
    if (d.name === FINAL_ANSWER) continue;
    const contract = defs[d.name!];
    assert.ok(contract, `tool ${d.name} is not in contracts/schemas/tool-args.schema.json`);
    const declared = (d.parametersJsonSchema as any).properties ?? {};
    for (const arg of Object.keys(declared)) {
      assert.ok(arg in (contract.properties ?? {}), `${d.name}.${arg} is declared in code but not in the contract`);
    }
    for (const req of (d.parametersJsonSchema as any).required ?? []) {
      assert.ok((contract.required ?? []).includes(req), `${d.name}.${req} is required in code but not in the contract`);
    }
  }
});
