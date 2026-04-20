import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PT Live & YouTube Player",
  description: "Paste a PT Live or YouTube URL and play it with optional live dubbing.",
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
