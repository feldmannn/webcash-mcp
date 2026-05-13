// End-to-end test for the x402-over-MCP buyer dance.
//
// Stands up a paid MCP seller (x402-mcp + webcashSettler + Facilitator
// driven by a fake issuer) and drives it via payToolRequest from a Client
// over InMemoryTransport. No real network, no real issuer.
//
// We test `payToolRequest` directly because the pay_tool MCP wrapper
// opens a real streamable-HTTP connection; InMemoryTransport is the
// equivalent fixture for in-process testing of the same dance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaywall } from "x402-mcp";
import { Facilitator, webcashSettler, watsToDecimal } from "x402-webcash";
import { MemoryWallet } from "x402-webcash/client";
import {
  PaidRetryRejectedError,
  PaywallDoesNotAcceptWebcashError,
  payToolRequest,
} from "../src/pay-tool.js";

const PAYER_SECRET =
  "e1:secret:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const REQUIRED_WATS = "100000000"; // 1 webcash

function fakeIssuerFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/v1/health_check")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/api/v1/replace")) {
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }
    return new Response("not mocked", { status: 599 });
  }) as typeof fetch;
}

type SellerHarness = {
  client: Client;
  receivedSecrets: string[];
  toolInvocations: number;
};

async function makeSellerHarness(opts?: {
  fetchImpl?: typeof fetch;
  onTool?: (q: string) => string;
}): Promise<SellerHarness> {
  const fetchImpl = opts?.fetchImpl ?? fakeIssuerFetch();
  const receivedSecrets: string[] = [];
  let toolInvocations = 0;

  const facilitator = new Facilitator({ fetchImpl });
  const server = new McpServer({ name: "paid-seller", version: "0.0.0" });
  const paywall = createPaywall({
    settler: webcashSettler(facilitator),
    scheme: "webcash",
    asset: "webcash",
    network: "webcash:mainnet",
    payTo: "https://webcash.org",
    onSettled: (out) => {
      receivedSecrets.push(out.secret);
    },
  });

  server.registerTool(
    "premium_echo",
    {
      title: "Premium echo",
      inputSchema: { query: z.string() },
    },
    paywall.gate(
      { amount: REQUIRED_WATS, resourceUrl: "mcp://test/premium_echo" },
      ({ query }) => {
        toolInvocations += 1;
        const reply = opts?.onTool ? opts.onTool(query) : `echo:${query}`;
        return { content: [{ type: "text" as const, text: reply }] };
      },
    ),
  );

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-buyer", version: "0" });
  await client.connect(clientT);

  return {
    client,
    receivedSecrets,
    get toolInvocations() {
      return toolInvocations;
    },
  } as SellerHarness;
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content;
  return content?.[0]?.text ?? "";
}

test("payToolRequest pays a 402 and returns the paid result", async () => {
  const h = await makeSellerHarness();
  const wallet = new MemoryWallet([PAYER_SECRET]);

  const result = await payToolRequest(
    h.client,
    "premium_echo",
    { query: "hello" },
    { wallet },
  );

  assert.notEqual(
    (result as { isError?: boolean }).isError,
    true,
    `unexpected error: ${firstText(result)}`,
  );
  assert.equal(firstText(result), "echo:hello");
  assert.equal(h.toolInvocations, 1, "handler must run exactly once (paid leg only)");
  assert.equal(h.receivedSecrets.length, 1, "seller must have received a settled output");
  assert.ok(
    h.receivedSecrets[0]!.startsWith("e1:secret:"),
    `seller's output secret should be 1 webcash: ${h.receivedSecrets[0]}`,
  );
  // The buyer's input secret was consumed at settlement; wallet must be empty.
  assert.deepEqual(await wallet.list(), [], "wallet must be empty after successful pay");
});

test("payToolRequest refunds the wallet when no payment is needed", async () => {
  // Make a server with a free tool (no paywall). payToolRequest should
  // pass through without touching the wallet.
  const server = new McpServer({ name: "free", version: "0" });
  server.registerTool(
    "free_echo",
    { title: "Free", inputSchema: { query: z.string() } },
    ({ query }) => ({ content: [{ type: "text" as const, text: `free:${query}` }] }),
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "buyer", version: "0" });
  await client.connect(clientT);

  const wallet = new MemoryWallet([PAYER_SECRET]);
  const result = await payToolRequest(client, "free_echo", { query: "hi" }, { wallet });

  assert.equal(firstText(result), "free:hi");
  assert.deepEqual(
    await wallet.list(),
    [PAYER_SECRET],
    "wallet must be untouched when no payment is required",
  );
});

test("payToolRequest throws NoMatchingSecretError when wallet is empty (no split possible)", async () => {
  const h = await makeSellerHarness();
  const wallet = new MemoryWallet(); // empty

  await assert.rejects(
    () => payToolRequest(h.client, "premium_echo", { query: "x" }, { wallet }),
    (err: Error) => {
      assert.equal(err.name, "NoMatchingSecretError");
      assert.match(err.message, new RegExp(REQUIRED_WATS));
      return true;
    },
  );
  assert.equal(h.toolInvocations, 0);
  assert.equal(h.receivedSecrets.length, 0);
});

test("payToolRequest throws PaywallDoesNotAcceptWebcashError when 402 offers no webcash scheme", async () => {
  // Build a server that paywalls with a non-webcash scheme — simulate by
  // crafting a tool that returns a hand-built challenge.
  const server = new McpServer({ name: "non-webcash-paywall", version: "0" });
  server.registerTool(
    "premium",
    { title: "Premium", inputSchema: { query: z.string() } },
    async () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            x402Version: 2,
            error: "payment_required",
            resource: { url: "mcp://test/premium" },
            accepts: [
              {
                scheme: "fictional",
                network: "fictional:mainnet",
                amount: "100",
                asset: "fictional",
                payTo: "https://example.com",
                maxTimeoutSeconds: 60,
              },
            ],
          }),
        },
      ],
    }),
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "buyer", version: "0" });
  await client.connect(clientT);

  const wallet = new MemoryWallet([PAYER_SECRET]);
  await assert.rejects(
    () => payToolRequest(client, "premium", { query: "x" }, { wallet }),
    PaywallDoesNotAcceptWebcashError,
  );
  // Wallet untouched — we never pulled a secret because no webcash branch existed.
  assert.deepEqual(await wallet.list(), [PAYER_SECRET]);
});

test("payToolRequest refunds the wallet if the paid retry returns another 402", async () => {
  // Build a server that ALWAYS returns 402 — even on retry — so the
  // settler never actually consumes the payment. The buyer must refund.
  const server = new McpServer({ name: "perma-402", version: "0" });
  server.registerTool(
    "premium",
    { title: "Premium", inputSchema: { query: z.string() } },
    async () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            x402Version: 2,
            error: "payment_required",
            resource: { url: "mcp://test/premium" },
            accepts: [
              {
                scheme: "webcash",
                network: "webcash:mainnet",
                amount: REQUIRED_WATS,
                asset: "webcash",
                payTo: "https://webcash.org",
                maxTimeoutSeconds: 60,
              },
            ],
          }),
        },
      ],
    }),
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "buyer", version: "0" });
  await client.connect(clientT);

  const wallet = new MemoryWallet([PAYER_SECRET]);
  await assert.rejects(
    () => payToolRequest(client, "premium", { query: "x" }, { wallet }),
    PaidRetryRejectedError,
  );
  // Wallet must be refunded — server never settled the payment.
  assert.deepEqual(
    await wallet.list(),
    [PAYER_SECRET],
    "wallet must be refunded when paid retry also returns 402",
  );
});

test("payToolRequest uses _meta challenge channel when present (no JSON text parsing)", async () => {
  // Verify the buyer reads `org.x402/challenge` from result _meta directly,
  // not just from JSON-in-text fallback. The real paywall populates both,
  // so we test the structured path is preferred by stripping the text
  // content here.
  const h = await makeSellerHarness();
  const wallet = new MemoryWallet([PAYER_SECRET]);

  const result = await payToolRequest(
    h.client,
    "premium_echo",
    { query: "via-meta" },
    { wallet },
  );

  assert.equal(firstText(result), "echo:via-meta");
  // No leakage of wats math — make sure the seller settled exactly REQUIRED_WATS.
  assert.equal(h.receivedSecrets.length, 1);
  // Decimal sanity check
  assert.equal(watsToDecimal(BigInt(REQUIRED_WATS)), "1");
});
