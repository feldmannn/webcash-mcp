// webcash-mcp — factory for an MCP server that exposes webcash as a payment
// method for AI agents. The bin entry (`src/cli.ts`) wires this to a stdio
// transport with a FileWallet; tests can build their own pair with
// MemoryWallet and InMemoryTransport.

import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NoMatchingSecretError,
  wrapFetchWithWebcash,
  type Wallet,
} from "x402-webcash/client";
import { isAcceptableIssuerScheme, parseSecret, watsToDecimal } from "x402-webcash";
import {
  PaidRetryRejectedError,
  PaywallDoesNotAcceptWebcashError,
  payToolRequest,
} from "./pay-tool.js";

export const VERSION = "0.2.2";

export type CreateServerOptions = {
  /** Wallet backing all paid calls and import/balance/status tools. */
  wallet: Wallet;
  /**
   * Human-readable wallet identifier shown in wallet_status and error
   * messages. For FileWallet, typically the resolved file path; for tests,
   * any short label.
   */
  walletLabel: string;
  /** Override the global fetch — useful for tests. Defaults to `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Sink for spend logs and quarantine warnings. Defaults to `console.error`
   * (stderr — the only safe channel under stdio transport). Tests can pass
   * a noop or capture function.
   */
  log?: (msg: string) => void;
};

export function createServer(opts: CreateServerOptions): McpServer {
  const { wallet, walletLabel } = opts;
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((msg: string) => console.error(msg));

  const pay = wrapFetchWithWebcash(fetchImpl, {
    wallet,
    autoSplit: {},
    journal: ({ amountWats, url }) => {
      const decimal = watsToDecimal(BigInt(amountWats));
      log(`[webcash-mcp][spend] ${decimal} webcash -> ${url}`);
    },
    onAmbiguous: ({ secret, status }) => {
      log(
        `[webcash-mcp][quarantine] status=${status} secret=${secret} — ` +
          `settlement may have succeeded at the issuer but the response was ambiguous; ` +
          `verify before reusing.`,
      );
    },
  });

  // Serialize wallet_import's check-then-put sequence so two concurrent
  // imports of the same secret can't both pass the dedup check and produce
  // a duplicate entry. FileWallet only serializes individual ops, not
  // multi-step flows.
  let importChain: Promise<unknown> = Promise.resolve();
  function serializeImport<T>(work: () => Promise<T>): Promise<T> {
    const run = importChain.then(work, work);
    importChain = run.catch(() => undefined);
    return run;
  }

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
          const needDecimal = watsToDecimal(BigInt(err.wats));
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Wallet at ${walletLabel} has no spendable secret for this call ` +
                  `(need ${needDecimal} webcash, and no larger secret is available to split). ` +
                  `Use wallet_import to add a secret, or wallet_balance to check current funds.`,
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
    "pay_tool",
    {
      title: "Pay and call a paywalled MCP tool",
      description:
        "Call a tool on a remote MCP server, transparently paying any x402-webcash 402 challenge " +
        "from the local wallet. The remote server is reached via streamable HTTP. Use this whenever " +
        "you need to invoke a tool whose seller has paywalled it via x402-mcp.",
      inputSchema: {
        serverUrl: z
          .string()
          .url()
          .describe("Absolute URL of the remote MCP server (streamable HTTP endpoint)."),
        toolName: z.string().describe("Name of the tool to call on the remote server."),
        toolArgs: z
          .record(z.unknown())
          .optional()
          .describe("Arguments object to pass to the remote tool (defaults to {})."),
      },
    },
    async ({ serverUrl, toolName, toolArgs }) => {
      // Refuse plaintext transports. The payment payload is a bearer
      // secret carried in request _meta over the streamable HTTP wire;
      // any on-path observer can race the legitimate facilitator and
      // steal the funds. Mirrors x402-webcash's Facilitator constructor
      // check on the seller side.
      if (!isAcceptableIssuerScheme(serverUrl, /* allowHttp */ false)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Refusing to call pay_tool against "${serverUrl}": only HTTPS or loopback URLs ` +
                `are accepted. Plaintext HTTP would leak the webcash bearer secret to any on-path ` +
                `observer.`,
            },
          ],
        };
      }
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      const client = new Client({ name: "webcash-mcp/pay_tool", version: VERSION });
      // Wall-clock budget for the entire dance (connect + probe + paid
      // retry + close). 90s default covers the x402-v2 recommended 60s
      // facilitator window plus handshake and refund slack. Aborts the
      // streamable-HTTP transport on timeout so a hung seller cannot
      // hang the agent indefinitely.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error("pay_tool timeout")), 90_000);
      try {
        await client.connect(transport);
        const result = await payToolRequest(client, toolName, (toolArgs ?? {}) as Record<string, unknown>, {
          wallet,
          splitFetchImpl: fetchImpl,
          signal: abort.signal,
        });
        // The remote MCP server's content blocks have already been
        // validated by the SDK on receive — forward them through. TS
        // can't see through the unknown to the union, so we cast.
        return formatRemoteResult(result) as never;
      } catch (err) {
        if (err instanceof NoMatchingSecretError) {
          const needDecimal = watsToDecimal(BigInt(err.wats));
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Wallet at ${walletLabel} has no spendable secret for ${toolName} on ${serverUrl} ` +
                  `(need ${needDecimal} webcash, and no larger secret is available to split). ` +
                  `Use wallet_import to add a secret, or wallet_balance to check current funds.`,
              },
            ],
          };
        }
        if (err instanceof PaywallDoesNotAcceptWebcashError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Remote server's 402 challenge does not accept the webcash scheme.`,
              },
            ],
          };
        }
        if (err instanceof PaidRetryRejectedError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Paid retry was rejected by ${serverUrl}; wallet has been refunded. ` +
                  `Paywall reason: ${err.secondChallenge.error ?? "(none)"}.`,
              },
            ],
          };
        }
        const msg = (err as Error)?.message ?? String(err);
        return { isError: true, content: [{ type: "text", text: `error: ${msg}` }] };
      } finally {
        clearTimeout(timer);
        try {
          await client.close();
        } catch {
          // Ignore close errors — the call already returned its result.
        }
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
      return serializeImport(async () => {
        const existing = await wallet.list();
        if (existing.includes(secret)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Secret already present in wallet (${parsed.decimal} webcash). No change made. ` +
                  `Note: this only checks for an identical entry — if you've already spent this ` +
                  `secret elsewhere, it will fail when used.`,
              },
            ],
          };
        }
        await wallet.put(secret);
        return {
          content: [
            {
              type: "text",
              text: `Imported ${parsed.decimal} webcash into ${walletLabel}.`,
            },
          ],
        };
      });
    },
  );

  server.registerTool(
    "wallet_status",
    {
      title: "Wallet diagnostic",
      description:
        "Report the wallet location, secret count, and server version. Use to confirm the MCP " +
        "server is wired to the wallet you expect.",
      inputSchema: {},
    },
    async () => {
      const secrets = await wallet.list();
      const text =
        `webcash-mcp ${VERSION}\n` +
        `wallet: ${walletLabel}\n` +
        `secrets: ${secrets.length}\n` +
        `auto-split: enabled`;
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

/**
 * Pass the remote tool's CallToolResult through unchanged so the agent
 * sees exactly what the paid tool returned — text, image, resource blocks,
 * structuredContent, etc.
 */
function formatRemoteResult(result: unknown): {
  isError?: boolean;
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  structuredContent?: unknown;
} {
  const r = (result ?? {}) as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: unknown;
  };
  const content =
    Array.isArray(r.content) && r.content.length > 0
      ? (r.content as Array<{ type: "text"; text: string } | Record<string, unknown>>)
      : [{ type: "text" as const, text: "(remote tool returned no content)" }];
  return {
    ...(r.isError ? { isError: true } : {}),
    content,
    ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
  };
}
