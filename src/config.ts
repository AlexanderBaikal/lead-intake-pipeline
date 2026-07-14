export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5433/lead_intake",
  port: Number(process.env.PORT ?? 3210),

  /**
   * The calendar "mañana" is relative to. Enquiries arrive stamped in UTC;
   * the customer means their own Tuesday. See src/time.ts.
   */
  businessTimeZone: process.env.BUSINESS_TZ ?? "America/Panama",

  llmProvider: (process.env.LLM_PROVIDER ?? "mock") as "mock" | "anthropic",
  llmModel: process.env.LLM_MODEL ?? "claude-opus-5",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,

  budgetCeilingUsd: Number(process.env.BUDGET_CEILING_USD ?? 5),
  crmRateLimitPerMin: Number(process.env.CRM_RATE_LIMIT_PER_MIN ?? 60),
  crmWebhookUrl: process.env.CRM_WEBHOOK_URL || null,
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || null,
};
