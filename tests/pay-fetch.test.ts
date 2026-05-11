// End-to-end test for pay_fetch: stand up a mock fetch that simulates an
// HTTP 402 / x402-webcash paywall, seed a MemoryWallet with an
// exact-amount secret, and verify pay_fetch settles the 402 and returns
// the 200 body. No real network, no real issuer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryWallet } from "x402-webcash/client";
import { createServer } from "../src/server.js";

const EXACT_SECRET =
  "e1:secret:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
// 1 webcash == 1e8 wats; the mock paywall asks for exactly that.
const REQUIRED_WATS = "100000000";
const PAID_BODY = "premium payload — only paid agents see this";
const RESOURCE_URL = "http://localhost:9999/premium";

type Call = { url: string; xPayment: string | null };

function makePaywallFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const xPayment = headers.get("X-PAYMENT");
    calls.push({ url, xPayment });

    if (!xPayment) {
      const body = {
        x402Version: 2,
        resource: { url, description: "premium", mimeType: "text/plain" },
        accepts: [
          {
            scheme: "webcash",
            network: "webcash:mainnet",
            amount: REQUIRED_WATS,
            asset: "webcash",
            payTo: "https://webcash.org",
            maxTimeoutSeconds: 60,
            extra: { issuerUrl: "https://webcash.org" },
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    // Retry carries X-PAYMENT; respond with the paid body.
    return new Response(PAID_BODY, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  return { fetch: fakeFetch, calls };
}

async function makeHarness(opts: { wallet: MemoryWallet; fetchImpl: typeof fetch }) {
  const server = createServer({
    wallet: opts.wallet,
    walletLabel: "<test>",
    fetchImpl: opts.fetchImpl,
    log: () => {},
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientT);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

test("pay_fetch settles a 402 and returns the paid 200 body", async () => {
  const wallet = new MemoryWallet([EXACT_SECRET]);
  const { fetch, calls } = makePaywallFetch();
  const client = await makeHarness({ wallet, fetchImpl: fetch });

  const res = await client.callTool({
    name: "pay_fetch",
    arguments: { url: RESOURCE_URL },
  });
  const text = firstText(res);
  assert.notEqual((res as { isError?: boolean }).isError, true, `unexpected error response: ${text}`);
  assert.match(text, /HTTP 200/);
  assert.match(text, new RegExp(PAID_BODY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(calls.length, 2, "expected two fetches: probe + paid retry");
  assert.equal(calls[0]!.xPayment, null, "first fetch must not carry X-PAYMENT");
  assert.ok(calls[1]!.xPayment, "second fetch must carry X-PAYMENT");

  // The secret was spent; wallet should now be empty.
  assert.deepEqual(await wallet.list(), [], "wallet must be empty after a successful pay");
});

test("pay_fetch reports 'no spendable secret' when the wallet is empty", async () => {
  const wallet = new MemoryWallet();
  const { fetch } = makePaywallFetch();
  const client = await makeHarness({ wallet, fetchImpl: fetch });

  const res = await client.callTool({
    name: "pay_fetch",
    arguments: { url: RESOURCE_URL },
  });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(firstText(res), /no spendable secret/i);
});

test("pay_fetch returns the original 402 unchanged when the scheme isn't webcash", async () => {
  const wallet = new MemoryWallet([EXACT_SECRET]);
  const nonWebcashFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = {
      x402Version: 2,
      resource: { url, description: "premium" },
      accepts: [
        {
          scheme: "some-other-scheme",
          network: "mainnet",
          amount: "1",
          asset: "USDC",
          payTo: "0xdeadbeef",
          maxTimeoutSeconds: 60,
        },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  };
  const client = await makeHarness({ wallet, fetchImpl: nonWebcashFetch });

  const res = await client.callTool({
    name: "pay_fetch",
    arguments: { url: RESOURCE_URL },
  });
  // Non-webcash 402 passes through — pay_fetch surfaces it as an error
  // response (isError=true because status != 2xx) but the wallet is untouched.
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(firstText(res), /HTTP 402/);
  assert.deepEqual(await wallet.list(), [EXACT_SECRET], "wallet must not be touched");
});
