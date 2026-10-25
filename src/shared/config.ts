/**
 * Settings for every AP4M operation: environment variable NAMES plus the
 * service's own GET /public/config, which is unauthenticated and is the source
 * of truth for the chain and the contract addresses.
 *
 * Secrets are read from the environment or from --env-file and are never
 * printed, logged or returned by anything here. Only addresses are shown.
 */
import { readFileSync } from "node:fs";

export type Network = {
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  name: string;
  gasToken: string;
  faucetUrl?: string;
};

export type Contracts = {
  participantRegistry: string;
  paymentLedger: string;
  pooledEscrowVault: string;
  rlusdToken: string;
};

export type PublicConfig = {
  network: Network;
  contracts: Contracts;
  vaultBalance?: string;
  publicBaseUrl?: string;
  psps?: { psp_id: string; display_name: string; status: string }[];
};

export class SetupError extends Error {}

/** Load an extra .env-format file. A value already in the environment wins. */
export function loadEnvFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SetupError(`cannot read --env-file ${path}: ${(error as Error).message}`);
  }
  const held = new Set(Object.keys(process.env));
  process.loadEnvFile(path);
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((name): name is string => !!name && held.has(name));
}

/**
 * The first of `names` that is set and non-empty. Several names are accepted
 * because the onboarding env already in use calls some of these differently
 * from .env.example.
 */
export function env(names: readonly string[], what: string, required = true): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  if (!required) return "";
  throw new SetupError(`${what} is missing: set ${names.join(" or ")} in the environment or in --env-file`);
}

export const NAMES = {
  apiUrl: ["AP4M_API_URL"],
  teamName: ["TEAM_NAME"],
  agentKey: ["AGENT_PRIVATE_KEY"],
  agentAddress: ["AP4M_AGENT_ADDRESS"],
  merchantId: ["MERCHANT_PARTICIPANT_ID", "MERCHANT_ID"],
  merchantPayout: ["MERCHANT_PAYOUT_ADDRESS", "MERCHANT_PAYOUT"],
  submitterKey: ["MERCHANT_SUBMITTER_KEY", "MERCHANT_PRIVATE_KEY"],
  rpcUrl: ["AP4M_RPC_URL"],
  channelCap: ["CHANNEL_CAP"],
} as const;

export const DEFAULT_API_URL = "https://hackathon.ap4m.build";

/** Fetch GET /public/config. No authentication, so this works before sign-in. */
export async function publicConfig(apiUrl: string, timeoutMs = 20_000): Promise<PublicConfig> {
  const url = `${apiUrl.replace(/\/+$/, "")}/public/config`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new SetupError(`cannot reach ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new SetupError(`${url} answered HTTP ${response.status}`);
  const config = (await response.json()) as PublicConfig;
  if (!config?.network?.rpcUrl || !config?.contracts?.paymentLedger) {
    throw new SetupError(`${url} did not return a usable config`);
  }
  return config;
}

/**
 * The RPC to use: AP4M_RPC_URL when set, else the service's own.
 *
 * AGENTS.md records that the faucet host the service advertises has no DNS
 * records; that affects funding by hand, not the RPC, so the RPC is taken from
 * the service as the guides require.
 */
export function rpcUrl(config: PublicConfig): string {
  return env(NAMES.rpcUrl, "RPC URL", false) || config.network.rpcUrl;
}

export function explorerTx(config: PublicConfig, hash: string): string {
  return `${config.network.explorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

/** Guard against the one mistake the rules call out: payout must not be the agent wallet. */
export function checkDistinctWallets(agent: string, payout: string): void {
  if (agent && payout && agent.toLowerCase() === payout.toLowerCase()) {
    throw new SetupError(
      "the merchant payout address is the same as the agent wallet; AP4M requires payout, agent and funding wallets to differ",
    );
  }
}
