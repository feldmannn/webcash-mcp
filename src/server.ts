// webcash-mcp — factory for an MCP server that exposes webcash as a payment
// method for AI agents. The bin entry (`src/cli.ts`) wires this to a stdio
// transport with a FileWallet; tests can build their own pair with
// MemoryWallet and InMemoryTransport.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NoMatchingSecretError,
  wrapFetchWithWebcash,
  type Wallet,
} from "x402-webcash/client";
import { parseSecret, watsToDecimal } from "x402-webcash";

export const VERSION = "0.1.0";

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
