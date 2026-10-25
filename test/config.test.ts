import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAMES, SetupError, checkDistinctWallets, env, explorerTx, loadEnvFile, publicConfig, rpcUrl } from "../src/shared/config.ts";

function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const held: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) held[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    body();
  } finally {
    for (const [k, v] of Object.entries(held)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("env takes the first name that is set", () => {
  withEnv({ A_ONE: undefined, A_TWO: "second" }, () => {
    assert.equal(env(["A_ONE", "A_TWO"], "thing"), "second");
  });
  withEnv({ A_ONE: "first", A_TWO: "second" }, () => {
    assert.equal(env(["A_ONE", "A_TWO"], "thing"), "first");
  });
});

test("env treats blank as unset", () => {
  withEnv({ A_ONE: "   ", A_TWO: "second" }, () => {
    assert.equal(env(["A_ONE", "A_TWO"], "thing"), "second");
  });
});

test("env names every accepted variable when it throws", () => {
  withEnv({ A_ONE: undefined, A_TWO: undefined }, () => {
    assert.throws(() => env(["A_ONE", "A_TWO"], "the thing"), (e: unknown) => {
      assert.ok(e instanceof SetupError);
      assert.match((e as Error).message, /A_ONE or A_TWO/);
      assert.match((e as Error).message, /the thing/);
      return true;
    });
  });
});

test("env can be optional", () => {
  withEnv({ A_ONE: undefined }, () => {
    assert.equal(env(["A_ONE"], "thing", false), "");
  });
});

test("the merchant names used by the existing onboarding env are accepted", () => {
  // The onboarding .env calls these MERCHANT_PARTICIPANT_ID / MERCHANT_PAYOUT_ADDRESS,
  // while .env.example calls them MERCHANT_ID / MERCHANT_PAYOUT. Both must work.
  withEnv({ MERCHANT_PARTICIPANT_ID: "0xabc", MERCHANT_ID: undefined }, () => {
    assert.equal(env(NAMES.merchantId, "merchant"), "0xabc");
  });
  withEnv({ MERCHANT_PARTICIPANT_ID: undefined, MERCHANT_ID: "0xdef" }, () => {
    assert.equal(env(NAMES.merchantId, "merchant"), "0xdef");
  });
  withEnv({ MERCHANT_PAYOUT_ADDRESS: "0x111", MERCHANT_PAYOUT: undefined }, () => {
    assert.equal(env(NAMES.merchantPayout, "payout"), "0x111");
  });
});

test("payout must not be the agent wallet", () => {
  assert.throws(() => checkDistinctWallets("0xAbC", "0xabc"), (e: unknown) => {
    assert.ok(e instanceof SetupError);
    assert.match((e as Error).message, /wallets to differ/);
    return true;
  });
  // Different wallets, and a missing one, are both fine.
  checkDistinctWallets("0xabc", "0xdef");
  checkDistinctWallets("", "0xdef");
  checkDistinctWallets("0xabc", "");
});

test("loadEnvFile reports the names the shell already held", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap4m-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "SHADOWED_ONE=from-file\nFRESH_ONE=from-file\n", "utf8");
  withEnv({ SHADOWED_ONE: "from-shell", FRESH_ONE: undefined }, () => {
    const shadowed = loadEnvFile(file);
    assert.deepEqual(shadowed, ["SHADOWED_ONE"]);
    // A value already in the shell wins; a new one is taken from the file.
    assert.equal(process.env.SHADOWED_ONE, "from-shell");
    assert.equal(process.env.FRESH_ONE, "from-file");
  });
});

test("loadEnvFile refuses a path that is not there", () => {
  assert.throws(() => loadEnvFile(join(tmpdir(), "definitely-not-here.env")), SetupError);
});

test("rpcUrl prefers the override, else the service's own", () => {
  const config = { network: { rpcUrl: "https://from-service" }, contracts: {} } as never;
  withEnv({ AP4M_RPC_URL: undefined }, () => {
    assert.equal(rpcUrl(config), "https://from-service");
  });
  withEnv({ AP4M_RPC_URL: "https://override" }, () => {
    assert.equal(rpcUrl(config), "https://override");
  });
});

test("explorerTx builds a link without a double slash", () => {
  const config = { network: { explorerUrl: "https://explorer.example/" } } as never;
  assert.equal(explorerTx(config, "0xabc"), "https://explorer.example/tx/0xabc");
});

test("publicConfig turns an unreachable service into a SetupError", async () => {
  // Port 1 refuses immediately, so this needs no server and no network.
  await assert.rejects(() => publicConfig("http://127.0.0.1:1", 2000), SetupError);
});
