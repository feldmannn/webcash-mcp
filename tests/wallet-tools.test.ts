// Unit tests for wallet_balance / wallet_import / wallet_status against a
// MemoryWallet via the MCP SDK's in-memory transport. These cover the tools
// that don't touch the network; pay_fetch's network path is exercised in
// tests/pay-fetch.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryWallet } from "x402-webcash/client";
import { createServer } from "../src/server.js";

async function makeHarness(initialSecrets: string[] = []) {
  const wallet = new MemoryWallet(initialSecrets);
  const server = createServer({ wallet, walletLabel: "<test>", log: () => {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientT);
  return { client, wallet };
}

function firstText(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  assert.ok(Array.isArray(content) && content.length > 0, "result has no content");
  assert.equal(content[0].type, "text");
  return content[0].text;
}

const SECRET_1 = "e1:secret:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const SECRET_2 = "e0.5:secret:1111111111111111111111111111111111111111111111111111111111111111";
const SECRET_3 = "e0.5:secret:2222222222222222222222222222222222222222222222222222222222222222";

test("wallet_status reports version, label, and zero secrets when empty", async () => {
  const { client } = await makeHarness();
  const res = await client.callTool({ name: "wallet_status", arguments: {} });
  const text = firstText(res);
  assert.match(text, /webcash-mcp \d+\.\d+\.\d+/);
  assert.match(text, /wallet: <test>/);
  assert.match(text, /secrets: 0/);
  assert.match(text, /auto-split: enabled/);
});

test("wallet_balance on empty wallet returns 0", async () => {
  const { client } = await makeHarness();
  const res = await client.callTool({ name: "wallet_balance", arguments: {} });
  const text = firstText(res);
  assert.match(text, /Total: 0 webcash/);
  assert.match(text, /Secrets: 0/);
  // No denominations section when empty
  assert.doesNotMatch(text, /Denominations:/);
});

test("wallet_balance sums mixed denominations and lists breakdown", async () => {
  const { client } = await makeHarness([SECRET_1, SECRET_2, SECRET_3]);
  const res = await client.callTool({ name: "wallet_balance", arguments: {} });
  const text = firstText(res);
  // 1 + 0.5 + 0.5 = 2.0 webcash
  assert.match(text, /Total: 2 webcash/);
  assert.match(text, /Secrets: 3/);
  assert.match(text, /Denominations:/);
  // 1.0 should be listed before 0.5 (sorted descending)
  const idx1 = text.indexOf("1 webcash x 1");
  const idx05 = text.indexOf("0.5 webcash x 2");
  assert.ok(idx1 > 0, `expected '1 webcash x 1' in:\n${text}`);
  assert.ok(idx05 > 0, `expected '0.5 webcash x 2' in:\n${text}`);
  assert.ok(idx1 < idx05, "1 webcash should be listed before 0.5 webcash");
});

test("wallet_import rejects malformed secret", async () => {
  const { client, wallet } = await makeHarness();
  const res = await client.callTool({
    name: "wallet_import",
    arguments: { secret: "not-a-valid-secret" },
  });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(firstText(res), /Invalid webcash secret/);
  assert.deepEqual(await wallet.list(), []);
});

test("wallet_import accepts a valid secret and persists it", async () => {
  const { client, wallet } = await makeHarness();
  const res = await client.callTool({
    name: "wallet_import",
    arguments: { secret: SECRET_1 },
  });
  assert.notEqual((res as { isError?: boolean }).isError, true);
  assert.match(firstText(res), /Imported 1 webcash/);
  assert.deepEqual(await wallet.list(), [SECRET_1]);
});

test("wallet_import detects duplicates and refuses to add a second copy", async () => {
  const { client, wallet } = await makeHarness([SECRET_1]);
  const res = await client.callTool({
    name: "wallet_import",
    arguments: { secret: SECRET_1 },
  });
  assert.match(firstText(res), /already present/);
  assert.deepEqual(await wallet.list(), [SECRET_1], "wallet must not gain a duplicate entry");
});

test("wallet_import dedup holds under concurrent calls (race regression)", async () => {
  const { client, wallet } = await makeHarness();
  // Fire two imports of the same secret in parallel. With the mutex in place
  // exactly one should succeed and the other should report 'already present'.
  const [a, b] = await Promise.all([
    client.callTool({ name: "wallet_import", arguments: { secret: SECRET_1 } }),
    client.callTool({ name: "wallet_import", arguments: { secret: SECRET_1 } }),
  ]);
  const texts = [firstText(a), firstText(b)];
  const imported = texts.filter((t) => /Imported/.test(t)).length;
  const dups = texts.filter((t) => /already present/.test(t)).length;
  assert.equal(imported, 1, `expected exactly one 'Imported' response, got: ${texts.join(" | ")}`);
  assert.equal(dups, 1, `expected exactly one 'already present' response, got: ${texts.join(" | ")}`);
  assert.equal((await wallet.list()).length, 1, "wallet must hold exactly one entry");
});

test("pay_tool refuses non-HTTPS non-loopback serverUrl (no plaintext bearer secrets)", async () => {
  const { client } = await makeHarness();
  const res = await client.callTool({
    name: "pay_tool",
    arguments: {
      serverUrl: "http://example.com/mcp",
      toolName: "premium",
      toolArgs: {},
    },
  });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(
    firstText(res),
    /only HTTPS or loopback URLs/,
    "pay_tool must reject plaintext HTTP to non-loopback hosts",
  );
});

test("pay_tool accepts loopback HTTP (test rigs)", async () => {
  // We don't have a real server bound here — the call will fail at
  // connect-time. What matters is that the HTTPS guard does NOT short-
  // circuit it: we should see a network-style error, not the
  // "only HTTPS or loopback URLs" rejection.
  const { client } = await makeHarness();
  const res = await client.callTool({
    name: "pay_tool",
    arguments: {
      // Port 1 is reserved + unbound — connect refused fast.
      serverUrl: "http://127.0.0.1:1/mcp",
      toolName: "premium",
      toolArgs: {},
    },
  });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.doesNotMatch(
    firstText(res),
    /only HTTPS or loopback URLs/,
    "loopback http:// must pass the security guard (subsequent connect may fail, which is fine)",
  );
});

test("tools/list returns all five tools", async () => {
  const { client } = await makeHarness();
  const res = (await client.listTools()) as { tools: { name: string }[] };
  const names = res.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "pay_fetch",
    "pay_tool",
    "wallet_balance",
    "wallet_import",
    "wallet_status",
  ]);
});
