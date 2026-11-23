import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FibrePulse", template: "%s · FibrePulse" },
  description: "See your network. Understand your revenue. Grow your ISP.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a1020",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-KE">
      <body>{children}</body>
    </html>
  );
}
