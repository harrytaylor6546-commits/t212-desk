import { store } from "./store";
import type { Proposal } from "./agents/analyst";

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

const KEY = "proposals";

async function readAll(): Promise<StoredProposal[]> {
  return (await store.get<StoredProposal[]>(KEY)) ?? [];
}

export async function saveProposal(p: StoredProposal): Promise<void> {
  const all = await readAll();
  const idx = all.findIndex((x) => x.id === p.id);
  if (idx >= 0) all[idx] = p;
  else all.push(p);
  // keep the document small
  const trimmed = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  await store.set(KEY, trimmed);
}

export async function loadProposal(id: string): Promise<StoredProposal> {
  const all = await readAll();
  // allow a unique suffix match so phone typing is shorter, e.g. "RRlEQ" or the last 4 digits
  const exact = all.find((p) => p.id === id);
  if (exact) return exact;
  const partial = all.filter((p) => p.id.endsWith(id) || p.id.includes(id));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${id}" matches ${partial.length} proposals, be more specific`);
  throw new Error(`no proposal ${id}`);
}

export async function listProposals(): Promise<StoredProposal[]> {
  return (await readAll()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function newId(ticker: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${stamp}-${ticker.replace(/[^A-Za-z0-9]/g, "")}`;
}
