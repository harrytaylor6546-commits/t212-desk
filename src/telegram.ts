/** Minimal Telegram Bot API client. Plain text only, so nothing needs escaping. */

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
}

async function call<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result as T;
}

const LIMIT = 3900;

export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > LIMIT) {
    const cut = rest.lastIndexOf("\n", LIMIT);
    const at = cut > LIMIT / 2 ? cut : LIMIT;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    await call("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  }
}

export async function setWebhook(url: string, secret: string): Promise<unknown> {
  return call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo(): Promise<unknown> {
  return call("getWebhookInfo", {});
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string; first_name?: string; username?: string };
    from?: { id: number; first_name?: string; username?: string };
  };
}
