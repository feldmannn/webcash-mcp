// Buyer-side x402-over-MCP: take a connected MCP Client, call a tool that
// may demand payment, run the two-call 402 dance, return the paid result.
//
// Transport-agnostic — pass any connected Client. The pay_tool MCP tool
// in server.ts wraps this with a transient streamableHttp connection.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  buildWebcashHeader,
  NoMatchingSecretError,
  type Wallet,
} from "x402-webcash/client";
import { secretFingerprint, type PaymentRequired } from "x402-webcash";

// Wire-protocol constants for the x402-over-MCP dialect. These MUST match
// x402-mcp's exported X402_PAYMENT_META_KEY / X402_CHALLENGE_META_KEY. We
// don't import them so webcash-mcp does not gain a runtime dep on
// x402-mcp; if the dialect changes, both packages update together.
export const X402_PAYMENT_META_KEY = "org.x402/payment";
export const X402_CHALLENGE_META_KEY = "org.x402/challenge";

export type PayToolRequestOptions = {
  wallet: Wallet;
  /** Issuer used for auto-split if the wallet has no exact-amount secret. */
  splitFetchImpl?: typeof fetch;
  splitIssuerUrl?: string;
  splitLegalese?: Record<string, unknown>;
  /**
   * Optional AbortSignal applied to every MCP request leg. When the
   * signal fires, in-flight `callTool` calls reject and the wallet-
   * safety guarantees in the function doc still hold (the secret is
   * refunded on a thrown error).
   */
  signal?: AbortSignal;
};

export class PaywallDoesNotAcceptWebcashError extends Error {
  constructor() {
    super("paywall does not accept the webcash scheme");
    this.name = "PaywallDoesNotAcceptWebcashError";
  }
}

export class PaidRetryRejectedError extends Error {
  readonly secondChallenge: PaymentRequired;
  constructor(secondChallenge: PaymentRequired) {
    super(
      "paid retry was rejected; wallet has been refunded. See secondChallenge.error for the paywall's reason.",
    );
    this.name = "PaidRetryRejectedError";
    this.secondChallenge = secondChallenge;
  }
}

/**
 * Run the x402-over-MCP payment dance against a connected Client.
 *
 *   1. callTool with no payment metadata.
 *   2. If the response carries a 402 challenge (in result._meta or as JSON
 *      in the first text content block), build a webcash payment via the
 *      wallet (auto-splitting if necessary) and retry with the payment
 *      payload in request _meta under `org.x402/payment`.
 *   3. Return the paid CallToolResult.
 *
 * Wallet-safety guarantees:
 *   - The secret pulled for the retry is REMOVED from the wallet before
 *     the second call.
 *   - If the retry throws (network, protocol), the secret is returned to
 *     the wallet — the facilitator may not have run.
 *   - If the retry returns a second 402, the secret is returned to the
 *     wallet AND a CRITICAL line is logged with the secret fingerprint
 *     and seller-supplied resource URL (see KNOWN ATTACK below).
 *   - If the retry returns success OR a non-402 error, the secret is NOT
 *     returned; on success it was consumed at the issuer, on non-402
 *     error the issuer state is ambiguous (matches the HTTP middleware's
 *     existing discipline).
 *
 * KNOWN ATTACK — malicious seller fake-402-after-settle:
 *   A dishonest seller can settle the payment at their facilitator AND
 *   return a synthetic 402 challenge in the MCP response. The buyer's
 *   wallet thinks the payment did not settle, returns the secret to the
 *   wallet, and only discovers the spend much later when trying to use
 *   the secret elsewhere (the issuer rejects it as already-spent). The
 *   protocol does not currently bind output secrets to a buyer identity,
 *   so this attack cannot be fully prevented at the wire level. The
 *   CRITICAL log line emitted here is the audit trail: collect it from
 *   any wallet you operate at scale and watch for repeated `PaidRetry...`
 *   events keyed to a single seller URL.
 *
 * PRIVACY NOTE — args echoed on the probe leg:
 *   The first `callTool` sends `args` BEFORE payment. A seller who
 *   returns 402 and never gets paid has still seen the args. Callers
 *   handling sensitive content (private queries, personally identifying
 *   data) should redact or hash on the probe leg, or use scheme features
 *   not yet supported in v0 of this dialect.
 */
export async function payToolRequest(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  opts: PayToolRequestOptions,
): Promise<unknown> {
  // Leg 1: probe with no payment.
  const probe = await client.callTool(
    { name, arguments: args },
    undefined,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  const challenge = extractChallenge(probe);
  if (!challenge) return probe;

  // Build the payment. buildWebcashHeader handles wallet pull + auto-split.
  const built = await buildWebcashHeader(challenge, opts.wallet, {
    autoSplit: {
      issuerUrl: opts.splitIssuerUrl,
      fetchImpl: opts.splitFetchImpl,
      legalese: opts.splitLegalese,
    },
  });
  if (!built) {
    throw new PaywallDoesNotAcceptWebcashError();
  }

  // Leg 2: retry with the payment payload in _meta. On any error, return
  // the secret to the wallet — we cannot prove it was consumed.
  let paid: unknown;
  try {
    paid = await client.callTool(
      {
        name,
        arguments: args,
        _meta: { [X402_PAYMENT_META_KEY]: built.header },
      },
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  } catch (e) {
    await opts.wallet.put(built.secret);
    throw e;
  }

  // A second 402 SHOULD mean the paywall didn't accept the payment and
  // didn't settle it — in which case returning the secret is correct. A
  // dishonest seller, however, can settle the payment AND return a fake
  // 402 to trick the buyer into refunding. We can't tell the difference
  // at this layer; log CRITICAL so operators can audit. See KNOWN ATTACK
  // in the function doc.
  const secondChallenge = extractChallenge(paid);
  if (secondChallenge) {
    await opts.wallet.put(built.secret);
    // eslint-disable-next-line no-console
    console.error(
      `[webcash-mcp][CRITICAL] paid_retry_returned_402 ` +
        `tool=${name} ` +
        `resource=${secondChallenge.resource?.url ?? "(unknown)"} ` +
        `refunded_secret_fingerprint=${secretFingerprint(built.secret)} ` +
        `wats=${built.requirements.amount}. ` +
        `The secret has been returned to the wallet. If the seller in fact settled it, the next ` +
        `attempt to spend this secret will fail at the issuer. Audit this seller if you see this ` +
        `log line repeatedly.`,
    );
    throw new PaidRetryRejectedError(secondChallenge);
  }

  return paid;
}

// Re-export for callers that want to handle them at the MCP tool layer.
export { NoMatchingSecretError };

function extractChallenge(result: unknown): PaymentRequired | null {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    isError?: boolean;
    _meta?: Record<string, unknown>;
    content?: unknown[];
  };
  if (!r.isError) return null;

  // Preferred: structured _meta channel.
  const meta = r._meta?.[X402_CHALLENGE_META_KEY];
  if (isPaymentRequired(meta)) return meta;

  // Fallback: parse first text content.
  const first = Array.isArray(r.content) ? r.content[0] : undefined;
  if (first && typeof first === "object" && (first as { type?: string }).type === "text") {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") {
      try {
        const parsed = JSON.parse(text);
        if (isPaymentRequired(parsed)) return parsed;
      } catch {
        // Not a JSON challenge — fall through.
      }
    }
  }
  return null;
}

function isPaymentRequired(v: unknown): v is PaymentRequired {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  if (x.x402Version !== 2) return false;
  if (!Array.isArray(x.accepts) || x.accepts.length === 0) return false;

  // Validate each accepts[i] has the required typed fields. A buggy or
  // malicious seller could return a half-built challenge; without this
  // check, we'd pass it to buildWebcashHeader and the failure would
  // surface as a downstream type error instead of a clean rejection.
  for (const r of x.accepts as unknown[]) {
    if (!r || typeof r !== "object") return false;
    const rr = r as Record<string, unknown>;
    if (typeof rr.scheme !== "string") return false;
    if (typeof rr.network !== "string") return false;
    if (typeof rr.amount !== "string") return false;
    if (typeof rr.asset !== "string") return false;
    if (typeof rr.payTo !== "string") return false;
    if (typeof rr.maxTimeoutSeconds !== "number") return false;
  }

  // resource is REQUIRED by x402 v2 and we use it for the CRITICAL log
  // on the fake-402 path — enforce its shape too.
  if (!x.resource || typeof x.resource !== "object") return false;
  const res = x.resource as Record<string, unknown>;
  if (typeof res.url !== "string" || res.url.length === 0) return false;

  return true;
}
