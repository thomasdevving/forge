import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";

const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "FORGE — draw a payoff, get a derivative",
  description:
    "FORGE compiles payoffs you draw into Orca concentrated liquidity on Solana, certifies the replication error, executes through Orca CPIs and settles with real token balances.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0c0b0a" },
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
  ],
};

// Apply a stored theme before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("forge.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
