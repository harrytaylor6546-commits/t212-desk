import "dotenv/config";
import { fileURLToPath } from "node:url";

export type T212Env = "practice" | "live";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

const env = (process.env.T212_ENV ?? "practice").toLowerCase();
if (env !== "practice" && env !== "live") {
  throw new Error(`T212_ENV must be "practice" or "live", got "${env}"`);
}

export const config = {
  t212: {
    env: env as T212Env,
    baseUrl:
      env === "live"
        ? "https://live.trading212.com/api/v0"
        : "https://demo.trading212.com/api/v0",
    apiKey: process.env.T212_API_KEY ?? "",
    apiSecret: process.env.T212_API_SECRET ?? "",
  },
  research: {
    xBearerToken: process.env.X_BEARER_TOKEN ?? "",
    tavilyKey: process.env.TAVILY_API_KEY ?? "",
  },
  risk: {
    maxOrderFraction: num("RISK_MAX_ORDER_FRACTION", 0.05),
    maxOrderValue: num("RISK_MAX_ORDER_VALUE", 250),
    maxOrdersPerDay: num("RISK_MAX_ORDERS_PER_DAY", 3),
    blocklist: (process.env.RISK_BLOCKLIST ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  },
  dataDir: fileURLToPath(new URL("../data/", import.meta.url)),
};

export function requireT212Key(): void {
  if (!config.t212.apiKey) {
    throw new Error(
      "T212_API_KEY is not set. Copy .env.example to .env and add a PRACTICE key first.",
    );
  }
}
