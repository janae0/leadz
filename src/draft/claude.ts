import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import type { Facts } from "./facts.js";
import type { Template } from "./templates.js";

export interface DraftRequest {
  template: Template;
  facts: Facts;
  maxWords: number;
  bannedPhrases: string[];
  previousErrors?: string[]; // validator errors from the first attempt
}

export interface WrittenDraft {
  subject: string;
  body: string; // greeting through the question; no signature or footer
}

export type DraftWriter = (req: DraftRequest) => Promise<WrittenDraft>;

const DraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

const SYSTEM_PROMPT = `You write first-touch outreach emails for a small local web studio to independent businesses in their neighborhood. A person reviews every email before it is sent.

House style:
- A short, plain-spoken email from one real person to a local business owner. No hype, no marketing voice.
- Under the word limit you are given, counting the greeting.
- Exactly one specific problem, taken from the measured facts. One clear offer. End with one question as the call to action.
- Use only the facts provided. Never state or imply a number, measurement, or claim that is not in the facts — no guesses about traffic, revenue, rankings, or competitors. If a fact is absent, do not mention that topic.
- Do not write a signature, sign-off name, unsubscribe line, or address; those are added automatically. End the body with the question.
- The subject is short, specific, lower-key, and only mentions something the body also says. Never start it with "Re:" or "Fwd:".
- Never promise results or use phrases such as "guaranteed" or "#1 on Google".
- If the facts say the founding-client half-price setup applies, you may mention it once, briefly. Otherwise never mention pricing or discounts.`;

function userPrompt(req: DraftRequest): string {
  const lines = [
    `Template: ${req.template.name}`,
    `Angle: ${req.template.description}`,
    `Word limit: ${req.maxWords - 10}`,
    `Phrases that must not appear: ${req.bannedPhrases.join(", ")}`,
    "",
    "Facts (the only facts you may use):",
    JSON.stringify(req.facts, null, 2),
  ];
  if (req.previousErrors?.length) {
    lines.push("", "Your previous draft failed these checks. Fix every one:", ...req.previousErrors.map((e) => `- ${e}`));
  }
  lines.push("", 'Return the subject and the body. Start the body with a greeting such as "Hi there," or "Hi {business name} team,".');
  return lines.join("\n");
}

let client: Anthropic | null = null;

export const claudeWriter: DraftWriter = async (req) => {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: config.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(DraftSchema) },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt(req) }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to draft: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (!response.parsed_output) throw new Error(`Claude returned no parseable draft (stop_reason ${response.stop_reason})`);
  return { subject: response.parsed_output.subject.trim(), body: response.parsed_output.body.trim() };
};
