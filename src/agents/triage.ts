import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Dossier } from "../research/types";
import { renderBrief } from "../research/index";

/**
 * Cheap first pass. A fast model reads a one-screen brief per name and scores how likely
 * each is to have a genuine one-to-three-day catalyst. Only the top few go to the full analyst.
 */

const TriageSchema = z.object({
  ranked: z.array(
    z.object({
      ticker: z.string(),
      catalystScore: z.number().min(0).max(10),
      direction: z.enum(["up", "down", "unclear"]),
      reason: z.string(),
    }),
  ),
});
export type Triage = z.infer<typeof TriageSchema>["ranked"][number];

const SYSTEM = `You triage candidates for a short-horizon equity desk. Trades are held one to three trading days.
For each brief, score 0-10 how likely it is that a specific, dated catalyst (results, guidance, contract,
broker action, index change, regulatory decision, a sharp move with follow-through potential) will move
the price inside the next three sessions. Old news scores low. Generic bullishness scores low. A stock that
already moved on news scores lower than one where the news is fresh and the move is incomplete.
Give direction "up" only when the likely move is upward; the desk can only buy.
Return every ticker you were given, best first. Reply with JSON only, matching:
{"ranked":[{"ticker":"...","catalystScore":0-10,"direction":"up|down|unclear","reason":"one line"}]}`;

export async function triage(dossiers: Dossier[]): Promise<Triage[]> {
  if (!dossiers.length) return [];
  const client = new Anthropic();
  const briefs = dossiers.map((d) => renderBrief(d)).join("\n\n");
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\n${briefs}` }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = TriageSchema.safeParse(JSON.parse(jsonText));
  if (!parsed.success) throw new Error(`triage returned unexpected JSON: ${parsed.error.message}`);
  const known = new Set(dossiers.map((d) => d.ticker));
  return parsed.data.ranked.filter((r) => known.has(r.ticker)).sort((a, b) => b.catalystScore - a.catalystScore);
}
