export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://lead:lead@localhost:5433/lead_intake",
  port: Number(process.env.PORT ?? 3210),
};
