# webcash-mcp

An MCP (Model Context Protocol) server that lets AI agents pay any HTTP 402 / [x402-webcash](https://github.com/feldmannn/x402-webcash) paywalled URL using bearer e-cash from a local wallet.

Drop it into any MCP client — Claude Desktop, your own agent harness — and the agent gains a payment method: it can call paid endpoints, top up its wallet, and check its balance, all as MCP tool calls.

## Why

The x402-webcash protocol settles HTTP 402 challenges in webcash, a zero-fee bearer e-cash. That's the right primitive for agent-to-agent commerce: no accounts, no chargebacks, no per-tx fee floor. But for agents that speak MCP and not raw HTTP, there was no bridge — until now. This server is that bridge.

## Install

```bash
npx webcash-mcp
```

(Requires Node.js 20+. Once published to npm — for now, see "Local development" below.)

## Wire into Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "webcash": {
      "command": "npx",
      "args": ["webcash-mcp"],
      "env": {
        "WEBCASH_WALLET": "/absolute/path/to/your-wallet.json"
      }
    }
  }
}
```

Restart Claude Desktop. The four tools below will be available to the assistant.

## Seed the wallet

Before the first paid call, put a webcash secret in your wallet file:

```json
{ "secrets": ["e1:secret:<your-hex-here>"] }
```

You can also import secrets at runtime via the `wallet_import` tool.

Auto-split is enabled by default, so any denomination >= ~0.3 webcash can be broken into smaller exact amounts as needed.

## Tools

### `pay_fetch`

Fetch any URL. If the response is a 402 challenge from an x402-webcash paywall, the server pays it transparently using a secret from the wallet, then retries and returns the body.

Args:
- `url` (string, required) — absolute URL to fetch
- `method` (string, optional) — HTTP method, default `GET`
- `body` (string, optional) — request body as raw string
- `headers` (object, optional) — extra HTTP headers as a `{ "name": "value" }` map

### `wallet_balance`

Returns the total unspent webcash in the local wallet, the number of secrets, and a denomination breakdown.

### `wallet_import`

Adds a webcash secret to the wallet so it can be spent. Validates the format before saving. Use to top up between sessions.

Args:
- `secret` (string, required) — webcash secret of the form `e<amount>:secret:<hex>`

### `wallet_status`

Diagnostic: reports the wallet file path, secret count, and server version. Use to confirm the server is wired to the wallet you expect.

## Security model — read this

The MCP server **pays without a per-call confirmation prompt**. An agent that can call `pay_fetch` can drain the wallet by hitting an attacker-controlled paywall with a high quote. Mitigations:

1. **Fund the wallet only with what you're willing to spend in a session.** Treat it like cash in a physical wallet — not your bank account.
2. **Audit spends in real time.** Every payment is logged to stderr in the form `[webcash-mcp][spend] <amount> webcash -> <url>`. Watch your MCP client's server logs.
3. Wallet writes are atomic and concurrency-safe via `x402-webcash`'s `FileWallet`.

A future version will add a `WEBCASH_MAX_PER_CALL_WATS` cap that inspects the 402 quote before paying.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBCASH_WALLET` | `./client-wallet.json` | Absolute path to the wallet JSON file |

## Local development

Until `x402-webcash` is published to npm, this package depends on it via a local file path. To run from source:

```bash
git clone https://github.com/feldmannn/x402-webcash.git
git clone https://github.com/feldmannn/webcash-mcp.git
cd x402-webcash && npm install && npm run build && cd ..
cd webcash-mcp && npm install && npm run build
node dist/server.js
```

To run via tsx without building:

```bash
cd webcash-mcp && npm run dev
```

## Relationship to x402-webcash

`x402-webcash` is the protocol library — it implements the HTTP 402 / webcash payment scheme. `webcash-mcp` is a thin MCP wrapper around it: every tool here delegates to `x402-webcash`'s `FileWallet` and `wrapFetchWithWebcash`. If you're building a non-MCP client (a CLI, a server middleware, a different transport), use `x402-webcash` directly instead.

## License

MIT
