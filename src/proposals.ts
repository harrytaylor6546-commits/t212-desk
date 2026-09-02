import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Proposal } from "./agents/analyst.js";

export interface StoredProposal {
  id: string;
  createdAt: string;
  env: string;
  proposal: Proposal;
  context: { freeCash: number; currency: string; heldQuantity: number; lastPrice?: number; priceCurrency?: string };
  status: "pending" | "rejected" | "submitted" | "failed";
  orderId?: number;
  note?: string;
}

const dir = () => path.join(config.dataDir, "proposals");

export function saveProposal(p: StoredProposal): void {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${p.id}.json`), JSON.stringify(p, null, 2));
}

export function loadProposal(id: string): StoredProposal {
  const f = path.join(dir(), `${id}.json`);
  if (!fs.existsSync(f)) throw new Error(`no proposal ${id}`);
  return JSON.parse(fs.readFileSync(f, "utf8")) as StoredProposal;
}

export function listProposals(): StoredProposal[] {
  if (!fs.existsSync(dir())) return [];
  return fs
    .readdirSync(dir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8")) as StoredProposal)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function newId(ticker: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${stamp}-${ticker.replace(/[^A-Za-z0-9]/g, "")}`;
}
