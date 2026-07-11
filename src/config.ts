export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5433/lead_intake",
  port: Number(process.env.PORT ?? 3210),

  llmProvider: (process.env.LLM_PROVIDER ?? "mock") as "mock" | "anthropic",
  llmModel: process.env.LLM_MODEL ?? "claude-opus-5",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};
