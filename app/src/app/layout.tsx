import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jakarta", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "FORGE — custom SOL payoffs from Orca liquidity",
  description:
    "Draw what your SOL should be worth at close. FORGE builds that payoff from Orca SOL/USDC liquidity ranges, certifies the worst-case error and opens it as an on-chain position. LPs who lend the ranges earn a premium.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#101216", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
