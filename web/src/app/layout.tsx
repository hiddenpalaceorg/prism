import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// metadataBase makes every relative og:image/canonical URL absolute — link
// unfurlers (Discord, Slack, Twitter) reject relative image URLs. SITE_URL
// overrides for non-production hosts; the default is where hpwiki:6800 is
// publicly proxied.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "https://hiddenpalace.org"),
  title: { default: "Prism", template: "%s · Hidden Palace" },
  description: "The Hidden Palace build library — browsable, searchable game builds with file listings, similarity matching, and viewable assets.",
  openGraph: { siteName: "Hidden Palace", type: "website" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
