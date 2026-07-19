import { z } from "zod";

import { isPriced } from "./pricing.js";

/**
 * Configuration is parsed and validated once, at boot, so a bad value stops
 * the process instead of surfacing as a strange result on the hundredth lead.
 *
 * The checks that matter are the ones a typo would otherwise pass silently:
 * `LLM_PROVIDER=antropic` used to fall through to the offline parser and tag
 * every lead `heuristic` while looking healthy, and an unpriced `LLM_MODEL`
 * only failed once a worker had already picked up a job.
 */

const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const Env = z
  .object({
    DATABASE_URL: z.string().default("postgres://lead:lead@localhost:5433/lead_intake"),
    PORT: z.coerce.number().int().positive().max(65_535).default(3210),

    /**
     * The calendar "mañana" is relative to. Enquiries arrive stamped in UTC;
     * the customer means their own Tuesday. See src/time.ts.
     */
    BUSINESS_TZ: z
      .string()
      .refine(isTimeZone, "not a known IANA time zone")
      .default("America/Panama"),

    LLM_PROVIDER: z.enum(["mock", "anthropic", "ollama"]).default("mock"),
    LLM_MODEL: z.string().default("claude-opus-5"),
    ANTHROPIC_API_KEY: z.string().optional(),

    /**
     * A model on your own machine. Nothing is billed, so nothing here is
     * checked against src/pricing.ts — but two things this file cannot catch
     * still fail on the first lead: a model Ollama has not pulled, and one
     * whose build cannot do schema-constrained output at all. `gemma3:12b-it-qat`
     * is the second kind: it answers fine untyped and returns HTTP 500
     * "failed to load model vocabulary required for format" the moment a
     * schema is attached. The default below is one that was checked.
     */
    OLLAMA_URL: z.url().default("http://localhost:11434"),
    OLLAMA_MODEL: z.string().default("qwen2.5:14b-instruct-q4_K_M"),

    BUDGET_CEILING_USD: z.coerce.number().positive().default(5),
    CRM_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),

    CRM_WEBHOOK_URL: z.url().nullable().default(null),
    NOTIFY_WEBHOOK_URL: z.url().nullable().default(null),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER !== "anthropic") return;

    // Both of these are only reachable once a worker has claimed a job, which
    // turns a missing setting into five failed attempts and a dead lead.
    if (!isPriced(env.LLM_MODEL)) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_MODEL"],
        message: `"${env.LLM_MODEL}" has no published price, so the budget ceiling could not be enforced against it`,
      });
    }
    if (!env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "required when LLM_PROVIDER=anthropic",
      });
    }
  });

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env) {
  // A shell and `node --env-file` both deliver an unset variable as "", which
  // would coerce to 0 or fail a URL check. Blank means absent, so the defaults
  // above apply rather than a zero that looks deliberate.
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value?.trim()),
  );

  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    throw new Error(`invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;

  return {
    databaseUrl: env.DATABASE_URL,
    port: env.PORT,
    businessTimeZone: env.BUSINESS_TZ,
    llmProvider: env.LLM_PROVIDER,
    llmModel: env.LLM_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    ollamaUrl: env.OLLAMA_URL,
    ollamaModel: env.OLLAMA_MODEL,
    budgetCeilingUsd: env.BUDGET_CEILING_USD,
    crmRateLimitPerMin: env.CRM_RATE_LIMIT_PER_MIN,
    crmWebhookUrl: env.CRM_WEBHOOK_URL,
    notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL,
  } as const;
}

export const config = loadConfig();
