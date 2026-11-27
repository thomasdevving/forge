import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Onest, Sora } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";

const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sora", display: "swap" });
const onest = Onest({ subsets: ["latin"], variable: "--font-onest", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "FORGE — draw a payoff, get a derivative",
  description:
    "FORGE compiles payoffs you draw into Orca concentrated liquidity on Solana, certifies the replication error, executes through Orca CPIs and settles with real token balances.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#101216", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${onest.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
