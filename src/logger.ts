type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields: Record<string, unknown> = {}) =>
    emit("info", message, fields),
  warn: (message: string, fields: Record<string, unknown> = {}) =>
    emit("warn", message, fields),
  error: (message: string, fields: Record<string, unknown> = {}) =>
    emit("error", message, fields),
};
