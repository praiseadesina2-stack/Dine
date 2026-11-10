/**
 * Try the /find agent from the terminal:
 *   pnpm --filter @dine/ai find "something filling under 2000"
 *   pnpm --filter @dine/ai find            (interactive)
 * Add --trace to print tool calls and token usage.
 */
import dotenv from "dotenv";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { VENDORS } from "../../../../apps/api/src/data/vendors.js";
import { InMemoryCatalogue } from "./catalogue.js";
import { FindAgent, formatFindReply } from "./find-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const args = process.argv.slice(2);
const showTrace = args.includes("--trace");
const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();

const agent = new FindAgent({ catalogue: new InMemoryCatalogue(VENDORS) });
if (!agent.isConfigured()) {
  console.error(`GEMINI_API_KEY is not set. Expected it in ${path.resolve(__dirname, "../../../../.env")}`);
  process.exit(1);
}

async function ask(q: string) {
  const result = await agent.find(q);
  if (result.ok) console.log("\n" + formatFindReply(result) + "\n");
  else console.log(`\n[fallback: ${result.reason}] ${result.detail ?? ""}\n`);
  if (showTrace) {
    const t = result.trace;
    for (const a of t.attempts) console.log(`  (failed call: ${a.model} ${a.error})`);
    for (const s of t.steps) console.log(`  ${s.tool} ${JSON.stringify(s.args)}${s.error ? `  ERROR: ${s.error}` : ""}`);
    console.log(`  model=${t.model} in=${t.inputTokens} out=${t.outputTokens} ${t.ms}ms rejections=${t.rejections.length}\n`);
  }
}

/** Print the Gemini models this key can call. */
async function listModels() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.AI_PROVIDER_API_KEY });
  for await (const m of await ai.models.list({ config: { pageSize: 100 } })) {
    const name = m.name?.replace("models/", "") ?? "";
    if (name.includes("gemini") && m.supportedActions?.includes("generateContent")) console.log(name);
  }
}

async function main() {
  if (args.includes("--models")) return listModels();
  if (query) return ask(query);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const q = (await rl.question("you> ")).trim();
    if (!q || q === "exit") break;
    await ask(q);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
