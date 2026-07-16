import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { DevOverlayKiller } from "@/components/DevOverlayKiller";
import "./globals.css";

export const metadata: Metadata = {
  title: "星阵无限画布",
  description: "一句话出成品海报的 AI 视觉生产画布。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full`}
    >
      <body className="h-full overflow-hidden text-ink antialiased">
        <DevOverlayKiller />
        {children}
      </body>
    </html>
  );
}
