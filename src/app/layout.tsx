import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Registration Extractor",
  description: "Turn scanned registration sheets into a spreadsheet.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
