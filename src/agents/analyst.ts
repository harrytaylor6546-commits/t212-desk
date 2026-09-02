import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Dossier } from "../research/types.js";
import { renderDossier } from "../research/index.js";

export const ProposalSchema = z.object({
  action: z.enum(["BUY", "SELL", "NO_TRADE"]),
  ticker: z.string().describe("The Trading 212 ticker exactly as given"),
  confidence: z.number().min(0).max(1),
  thesis: z.string().describe("Two to four sentences. What the trade is and why now."),
  evidence: z
    .array(
      z.object({
        claim: z.string(),
        source: z.string().describe("URL or source name from the dossier"),
        weight: z.enum(["strong", "moderate", "weak"]),
      }),
    )
    .min(1),
  risks: z.array(z.string()).min(1).describe("What would make this wrong"),
  invalidation: z.string().describe("A concrete price level or event that kills the thesis"),
  suggestedSizeFraction: z
    .number()
    .min(0)
    .max(0.1)
    .describe("Fraction of free cash to commit. 0 for NO_TRADE. Never above 0.1."),
  orderType: z.enum(["MARKET", "LIMIT"]),
  limitPrice: z.number().nullable().describe("Only for LIMIT orders, in the instrument's quoted currency"),
  horizonDays: z.number().int().min(1).max(3).describe("Trading days the trade is expected to take. Max 3."),
  targetPrice: z.number().nullable().describe("Take-profit level in the quoted currency. Null only for NO_TRADE."),
  stopPrice: z.number().nullable().describe("Stop-loss level in the quoted currency. Null only for NO_TRADE."),
  catalyst: z.string().describe("The dated event or flow that should move the price inside the horizon. Be specific."),
  dataQuality: z.enum(["good", "thin", "poor"]).describe("How much evidence was actually available"),
});
export type Proposal = z.infer<typeof ProposalSchema>;

const SYSTEM = `You are the research analyst on a small personal trading desk. You read a dossier of
recent price action, news, and social chatter about one listed equity and produce a structured
proposal. A human reviews every proposal and makes the final call. You never execute anything.

Mandate: short swing trades only. Every position is closed within three trading days, no exceptions.
That rules out most "good company, buy and hold" reasoning. You are looking for a specific, dated
catalyst inside the window: results, a guidance change, an index inclusion, a broker move, a large
contract, a sharp move that is likely to mean-revert or continue over one to three sessions. If you
cannot name what should move the price inside three days, the answer is NO_TRADE.

Standards:
- NO_TRADE is the default answer. Only propose BUY or SELL when the evidence is specific, recent,
  and would still hold up if a sceptical colleague read the sources themselves.
- Every trade needs a target and a stop in the quoted currency. Size the stop so that being wrong
  costs less than being right pays. A trade with no clear stop is NO_TRADE.
- Old news is not a catalyst. A story from three weeks ago is context, not a reason to act now.
- Prefer liquid names where a market exit inside three days will not move the price.
- Weight sources honestly. A wire story or filing beats a Reddit post. Social sentiment alone is
  never enough for a trade.
- Separate what the sources say from what you infer. Put inferences in the thesis, not in evidence.
- If the dossier is thin or the sources contradict each other, say so in dataQuality and lean NO_TRADE.
- Keep sizing small. This is a retail account. Never suggest more than 10% of free cash.
- Prefer LIMIT orders when you can name a sensible price. Prefer MARKET only for liquid large caps
  where the entry price barely matters to the thesis.
- Be concrete about invalidation. A vague phrase like "if sentiment changes" is not an invalidation level.`;

export async function analyse(
  dossier: Dossier,
  context: { freeCash: number; currency: string; heldQuantity: number },
): Promise<Proposal> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(ProposalSchema) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          `Account context: free cash ${context.freeCash.toFixed(2)} ${context.currency}. Currently held: ${context.heldQuantity} shares of ${dossier.ticker}.`,
          `Produce a proposal for ${dossier.ticker} from the dossier below.`,
          "",
          renderDossier(dossier),
        ].join("\n"),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Analyst declined: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (!response.parsed_output) {
    throw new Error("Analyst returned output that did not match the proposal schema");
  }
  return response.parsed_output;
}
