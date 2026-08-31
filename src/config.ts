import * as dotenvLike from "node:fs";
import * as path from "node:path";

/**
 * Zero-config by default. With no .env the system runs entirely on the
 * simulator with the deterministic intent parser — it should never be the case
 * that the project cannot be started.
 */

function loadEnvFile(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!dotenvLike.existsSync(file)) return;
  const raw = dotenvLike.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment wins over file, so CI can override without editing files.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? path.resolve(process.cwd(), "data", "vyapaar.db"),

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
    /** Force the simulator even when keys are present (used by the demo). */
    forceSimulator: process.env.RAZORPAY_FORCE_SIMULATOR === "true",
  },

  llm: {
    apiKey: process.env.LLM_API_KEY ?? "",
    /** OpenAI-compatible chat completions endpoint. */
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    /** Force the deterministic parser even when a key is present. */
    forceHeuristic: process.env.LLM_FORCE_HEURISTIC === "true",
  },

  /** Public base URL, used to build webhook and return URLs. */
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
} as const;

export function razorpayEnabled(): boolean {
  return !config.razorpay.forceSimulator && Boolean(config.razorpay.keyId && config.razorpay.keySecret);
}

export function llmEnabled(): boolean {
  return !config.llm.forceHeuristic && Boolean(config.llm.apiKey);
}

/** The single most useful line in the logs: what mode am I actually in. */
export function modeSummary(): Record<string, string> {
  return {
    payments: razorpayEnabled() ? "razorpay-live-test-mode" : "simulator",
    intentParsing: llmEnabled() ? `llm:${config.llm.model}` : "heuristic",
    db: config.dbPath,
  };
}
