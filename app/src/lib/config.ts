/** Public configuration. Service URLs are server-side rewrites (next.config.ts). */
export const config = {
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "http://127.0.0.1:8890",
  wsUrl: process.env.NEXT_PUBLIC_SOLANA_WS_URL ?? "ws://127.0.0.1:8890",
  programId: process.env.NEXT_PUBLIC_FORGE_PROGRAM_ID ?? "8RQGTBgTpbvxZ9BFHpFthHRw5JkaHiUpfrMmjfUv3NN5",
  expectedGenesisHash: process.env.NEXT_PUBLIC_EXPECTED_GENESIS_HASH ?? "",
  repoUrl: "https://github.com/thomasdevving/forge",
};

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
