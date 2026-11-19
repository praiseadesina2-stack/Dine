/**
 * Diagnostic: send /start to Prime's bot and print what comes back (text and every
 * button, with its row/column and kind). Presses nothing. `pnpm --filter @dine/ai peek`
 */
import { DineOrderingAgent } from "./agent.js";

async function main() {
  const agent = new DineOrderingAgent();
  if (!agent.isConfigured()) throw new Error("Telegram session not configured");
  const client = await agent.getClient();
  const bot = await client.getEntity((process.env.PRIME_BOT_USERNAME || "orderfromprimebot").replace(/^@/, ""));
  const [before] = await client.getMessages(bot, { limit: 1 });
  // Optional: a bottom-keyboard label to send instead of /start (e.g. "🛒 My Cart"). Viewing only.
  await client.sendMessage(bot, { message: process.argv[2] || "/start" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_500));
    const msgs = await client.getMessages(bot, { limit: 5 });
    const fresh = msgs.filter((m: any) => !m.out && (!before || m.id > before.id));
    if (!fresh.length) continue;
    await new Promise((r) => setTimeout(r, 1_500));
    const settled = (await client.getMessages(bot, { limit: 5 })).filter((m: any) => !m.out && (!before || m.id > before.id));
    // Optional: inline buttons to press in turn, exact labels (e.g. "− Clear cart"); each on
    // the newest Prime message that has it. Prints the final screen.
    const labels = process.argv.slice(3);
    if (labels.length) {
      let lowest = Math.min(...(settled as any[]).map((m) => m.id));
      for (const label of labels) {
        const recent = (await client.getMessages(bot, { limit: 5 })).filter((m: any) => !m.out && m.id >= lowest);
        const target = (recent as any[]).find((m) => (m.replyMarkup?.rows ?? []).some((row: any) => row.buttons.some((b: any) => b.text === label)));
        if (!target) return console.log(`No button "${label}" on Prime's latest messages; stopped.`);
        await target.click({ text: label });
        console.log(`pressed "${label}"`);
        lowest = target.id;
        await new Promise((r) => setTimeout(r, 3_000));
      }
      const after = (await client.getMessages(bot, { limit: 3 })).filter((m: any) => !m.out && m.id >= lowest);
      for (const m of [...after].reverse() as any[]) {
        console.log(`\n=== message ${m.id} ===`);
        console.log(m.message);
        (m.replyMarkup?.rows ?? []).forEach((row: any, r: number) => (row.buttons ?? []).forEach((b: any, c: number) => console.log(`  [r${r}c${c}] ${JSON.stringify(b.text)}`)));
      }
      return;
    }
    for (const m of [...settled].reverse() as any[]) {
      console.log(`\n=== message ${m.id} (${m.replyMarkup?.className ?? "no keyboard"}) ===`);
      console.log(m.message);
      (m.replyMarkup?.rows ?? []).forEach((row: any, r: number) =>
        (row.buttons ?? []).forEach((b: any, c: number) => console.log(`  [r${r}c${c}] ${JSON.stringify(b.text)}${b.url ? ` url=${b.url}` : ""} (${b.className})`)),
      );
    }
    return;
  }
  console.log("Prime did not reply within 15 s");
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
