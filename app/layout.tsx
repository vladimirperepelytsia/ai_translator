import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PT Live Video Extractor",
  description: "Paste a PT Live recording share link and play the extracted MP4.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-white antialiased">{children}</body>
    </html>
  );
}
