import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Curator",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="antialiased">
      <body className={inter.className}>
        <div className="mx-auto px-2">
          <div className="flex h-12 items-center justify-between">
            <div className="flex items-center">
              <div className="hidden md:block">
                <div className="flex items-baseline">
                  <Link
                    href="/files"
                    className="text-slate-700 hover:bg-slate-300 hover:text-black rounded-md px-3 py-2 text-sm font-medium"
                  >
                    Index
                  </Link>
                  <Link
                    href="/builds"
                    className="text-slate-700 hover:bg-slate-300 hover:text-black rounded-md px-3 py-2 text-sm font-medium"
                  >
                    Build dates
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>{children}</div>
      </body>
    </html>
  );
}
