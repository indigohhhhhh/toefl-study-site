import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "词航 · 托福词汇学习",
  description: "私人托福单词、词组与间隔复习学习系统",
  applicationName: "词航",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "词航" },
};

export const viewport: Viewport = { themeColor: "#176b57", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
