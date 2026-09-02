export const dynamic = "force-dynamic";

export default function Home() {
  const env = (process.env.T212_ENV ?? "practice").toUpperCase();
  const checks = [
    ["T212_API_KEY", !!process.env.T212_API_KEY],
    ["ANTHROPIC_API_KEY", !!process.env.ANTHROPIC_API_KEY],
    ["TELEGRAM_BOT_TOKEN", !!process.env.TELEGRAM_BOT_TOKEN],
    ["TELEGRAM_CHAT_ID", !!process.env.TELEGRAM_CHAT_ID],
    ["TELEGRAM_WEBHOOK_SECRET", !!process.env.TELEGRAM_WEBHOOK_SECRET],
    ["CRON_SECRET", !!process.env.CRON_SECRET],
    ["BLOB_READ_WRITE_TOKEN", !!process.env.BLOB_READ_WRITE_TOKEN],
  ] as const;
  return (
    <main>
      <h1>t212-desk</h1>
      <p>Mode: {env}</p>
      <p>The desk is driven from Telegram. This page only shows which settings are present.</p>
      <ul>
        {checks.map(([name, ok]) => (
          <li key={name}>
            {ok ? "ok " : "missing "} {name}
          </li>
        ))}
      </ul>
    </main>
  );
}
