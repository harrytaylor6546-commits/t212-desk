import type { ReactNode } from "react";

export const metadata = { title: "t212-desk" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-monospace, monospace", padding: 24, maxWidth: 640 }}>{children}</body>
    </html>
  );
}
