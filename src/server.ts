#!/usr/bin/env node
// webcash-mcp — an MCP server exposing webcash as a payment method for AI agents.
//
// Pays any HTTP 402 / x402-webcash paywalled URL with bearer e-cash from a
// local file wallet. Stdio transport, drop into any MCP client (Claude
// Desktop, etc.) by adding to its server config.
//
// Env vars:
//   WEBCASH_WALLET — path to wallet JSON file (default ./client-wallet.json)
//
// Tools registered:
//   pay_fetch     — fetch any URL, settling 402 in webcash
//   wallet_balance — sum unspent webcash in the wallet
//   wallet_import  — add a webcash secret to the wallet
//   wallet_status  — wallet path + secret count + server version
//
// stderr is the only safe log channel — stdout carries MCP protocol traffic.

import { resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  FileWallet,
  NoMatchingSecretError,
  wrapFetchWithWebcash,
} from "x402-webcash/client";
import { parseSecret, watsToDecimal } from "x402-webcash";

const VERSION = "0.1.0";
const WALLET_FILE = resolve(process.env.WEBCASH_WALLET ?? "./client-wallet.json");

const wallet = new FileWallet(WALLET_FILE);

const pay = wrapFetchWithWebcash(fetch, {
  wallet,
  autoSplit: {},
  journal: ({ amountWats, url }) => {
    const decimal = watsToDecimal(BigInt(amountWats));
    console.error(`[webcash-mcp][spend] ${decimal} webcash -> ${url}`);
  },
  onAmbiguous: ({ secret, status }) => {
    console.error(
      `[webcash-mcp][quarantine] status=${status} secret=${secret} — settlement may have ` +
        `succeeded at the issuer but the response was ambiguous; verify before reusing.`,
    );
  },
});

const server = new McpServer({ name: "webcash-mcp", version: VERSION });

server.registerTool(
  "pay_fetch",
  {
    title: "Pay and fetch a URL",
    description:
      "Fetch a URL, transparently paying the HTTP 402 challenge with webcash from the local " +
      "wallet. Use this whenever a resource is paywalled with x402-webcash. The wallet pays " +
      "without a per-call confirmation prompt — fund it only with what you're willing to spend.",
    inputSchema: {
      url: z.string().url().describe("Absolute URL to fetch."),
      method: z.string().optional().describe("HTTP method (default: GET)."),
      body: z
        .string()
        .optional()
        .describe("Request body as a raw string. Set content-type via the headers field."),
      headers: z
        .record(z.string())
        .optional()
        .describe("Additional HTTP request headers as a key/value object."),
    },
  },
  async ({ url, method, body, headers }) => {
    try {
      const res = await pay(url, {
        method: method ?? "GET",
        headers,
        body,
      });
      const text = await res.text();
      const summary =
        `HTTP ${res.status} ${res.statusText}\n` +
        `content-type: ${res.headers.get("content-type") ?? "(none)"}\n\n${text}`;
      if (!res.ok) {
        return { isError: true, content: [{ type: "text", text: summary }] };
      }
      return { content: [{ type: "text", text: summary }] };
    } catch (err) {
      if (err instanceof NoMatchingSecretError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Wallet at ${WALLET_FILE} has no spendable secret for this call ` +
                `(need ${(err as NoMatchingSecretError & { wats?: string }).wats ?? "?"} wats, ` +
                `and no larger secret is available to split). Use wallet_import to add a secret, ` +
                `or wallet_balance to check current funds.`,
            },
          ],
        };
      }
      const msg = (err as Error)?.message ?? String(err);
      return { isError: true, content: [{ type: "text", text: `error: ${msg}` }] };
    }
  },
);

server.registerTool(
  "wallet_balance",
  {
    title: "Get wallet balance",
    description:
      "Sum the unspent webcash secrets in the local wallet. Returns total amount in webcash, " +
      "the number of secrets, and a breakdown by denomination.",
    inputSchema: {},
  },
  async () => {
    const secrets = await wallet.list();
    let totalWats = 0n;
    const denoms = new Map<string, number>();
    let unparseable = 0;
    for (const s of secrets) {
      const parsed = parseSecret(s);
      if (!parsed) {
        unparseable += 1;
        continue;
      }
      totalWats += parsed.wats;
      denoms.set(parsed.decimal, (denoms.get(parsed.decimal) ?? 0) + 1);
    }
    const breakdown = Array.from(denoms.entries())
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([d, n]) => `  ${d} webcash x ${n}`)
      .join("\n");
    const text =
      `Total: ${watsToDecimal(totalWats)} webcash\n` +
      `Secrets: ${secrets.length}` +
      (unparseable > 0 ? ` (${unparseable} unparseable)` : "") +
      (breakdown ? `\nDenominations:\n${breakdown}` : "");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "wallet_import",
  {
    title: "Import a webcash secret",
    description:
      "Add a webcash secret to the local wallet so it can be spent on future pay_fetch calls. " +
      "Secret format: e<amount>:secret:<hex>.",
    inputSchema: {
      secret: z.string().describe("Webcash secret in the form e<amount>:secret:<hex>."),
    },
  },
  async ({ secret }) => {
    const parsed = parseSecret(secret);
    if (!parsed) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Invalid webcash secret. Expected format: e<amount>:secret:<hex> " +
              "(e.g. e1:secret:abc123...).",
          },
        ],
      };
    }
    await wallet.put(secret);
    return {
      content: [
        {
          type: "text",
          text: `Imported ${parsed.decimal} webcash into ${WALLET_FILE}.`,
        },
      ],
    };
  },
);

server.registerTool(
  "wallet_status",
  {
    title: "Wallet diagnostic",
    description:
      "Report the wallet file path, secret count, and server version. Use to confirm the MCP " +
      "server is wired to the wallet you expect.",
    inputSchema: {},
  },
  async () => {
    const secrets = await wallet.list();
    const text =
      `webcash-mcp ${VERSION}\n` +
      `wallet: ${WALLET_FILE}\n` +
      `secrets: ${secrets.length}\n` +
      `auto-split: enabled`;
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());

console.error(`webcash-mcp ${VERSION} ready. wallet=${WALLET_FILE}`);
