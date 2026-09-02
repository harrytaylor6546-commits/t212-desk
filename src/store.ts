import fs from "node:fs/promises";
import path from "node:path";
import { get as blobGet, put as blobPut } from "@vercel/blob";

/**
 * Tiny JSON document store. Local runs write files under ./data.
 * On Vercel (BLOB_READ_WRITE_TOKEN present) the same documents live in a private Blob store.
 */
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

function fsStore(dir: string): Store {
  const file = (key: string) => path.join(dir, `${key}.json`);
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        return JSON.parse(await fs.readFile(file(key), "utf8")) as T;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), JSON.stringify(value, null, 2));
    },
  };
}

function blobStore(): Store {
  const pathname = (key: string) => `desk/${key}.json`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const res = await blobGet(pathname(key), { access: "private", useCache: false });
      if (!res || !("stream" in res) || !res.stream) return null;
      const text = await new Response(res.stream as ReadableStream).text();
      return text ? (JSON.parse(text) as T) : null;
    },
    async set(key: string, value: unknown): Promise<void> {
      await blobPut(pathname(key), JSON.stringify(value), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
    },
  };
}

export const store: Store = process.env.BLOB_READ_WRITE_TOKEN
  ? blobStore()
  : fsStore(path.join(process.cwd(), "data"));

export const storeKind = process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "local files";
