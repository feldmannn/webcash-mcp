# webcash-mcp

An MCP (Model Context Protocol) server that lets AI agents pay any [x402-webcash](https://github.com/feldmannn/x402-webcash)-paywalled HTTP URL **or** paywalled MCP tool, using bearer e-cash from a local wallet.

Drop it into any MCP client — Claude Desktop, your own agent harness — and the agent gains a payment method: it can call paid HTTP endpoints, call paid tools on other MCP servers, top up its wallet, and check its balance, all as MCP tool calls.

## Why

The x402-webcash protocol settles HTTP 402 challenges in webcash, a zero-fee bearer e-cash. That's the right primitive for agent-to-agent commerce: no accounts, no chargebacks, no per-tx fee floor. But for agents that speak MCP and not raw HTTP, there was no bridge — until now. This server is that bridge.

## Install

```bash
npx webcash-mcp
```

(Requires Node.js 20+.)

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

Restart Claude Desktop. The five tools below will be available to the assistant.

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

### `pay_tool`

Call a tool on a remote MCP server. If the remote server paywalls the tool with an [x402-mcp](https://www.npmjs.com/package/@feldmannn/x402-mcp) 402 challenge, the server pays it transparently from the wallet and returns the paid result.

Plaintext HTTP is refused — only HTTPS or loopback URLs are accepted, because the webcash bearer secret is carried in `_meta` over the wire and any on-path observer could race the legitimate facilitator to spend it.

Args:
- `serverUrl` (string, required) — absolute URL of the remote MCP server (streamable HTTP endpoint)
- `toolName` (string, required) — name of the tool to call on the remote server
- `toolArgs` (object, optional) — arguments object to pass to the remote tool (default `{}`)

### `wallet_balance`

Returns the total unspent webcash in the local wallet, the number of secrets, and a denomination breakdown.

### `wallet_import`

Adds a webcash secret to the wallet so it can be spent. Validates the format before saving. Use to top up between sessions.

Args:
- `secret` (string, required) — webcash secret of the form `e<amount>:secret:<hex>`

### `wallet_status`

Diagnostic: reports the wallet file path, secret count, and server version. Use to confirm the server is wired to the wallet you expect.

## Security model — read this

The MCP server **pays without a per-call confirmation prompt**. An agent that can call `pay_fetch` or `pay_tool` can drain the wallet by hitting an attacker-controlled paywall with a high quote. Mitigations:

1. **Fund the wallet only with what you're willing to spend in a session.** Treat it like cash in a physical wallet — not your bank account.
2. **Audit spends in real time.** Every payment is logged to stderr in the form `[webcash-mcp][spend] <amount> webcash -> <url>`. The spend log is secret-safe — it records amounts and URLs only.
3. **Watch for `[webcash-mcp][CRITICAL]` lines.** `pay_tool` emits one if a seller returns a second 402 after a payment retry — a dishonest seller can settle the payment AND return a fake 402 to trick the wallet into refunding a secret that's already been spent. The log line records the secret **fingerprint** (not the secret itself) and the seller URL so you can audit repeat offenders.
4. **`[webcash-mcp][quarantine]` lines contain raw webcash secrets in plaintext.** These fire when an HTTP 402 retry's outcome is ambiguous (the network failed mid-settle) and the secret may or may not have been spent at the issuer. The operator needs the secret in the log to manually verify and possibly recover — but anyone else who can read the log can spend it. **Do not ship stderr to third-party log aggregators without redacting `secret=`.** Same applies to the `[x402-webcash][CRITICAL]` lines bubbled up from the underlying library (see [`x402-webcash` README §"Operator security"](https://github.com/feldmannn/x402-webcash#operator-security-the-recovery-log) for the full inventory).
5. Wallet writes are atomic and concurrency-safe **within a single process** (`FileWallet` uses an in-process mutex). Do **not** point two processes at the same wallet file — concurrent writes across processes can lose secrets. If you need multi-process access, use a SQLite- or keychain-backed wallet that implements the same `Wallet` interface.

A future version will add a `WEBCASH_MAX_PER_CALL_WATS` cap that inspects the 402 quote before paying.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBCASH_WALLET` | `./client-wallet.json` | Absolute path to the wallet JSON file |

## Local development

To run from source:

```bash
git clone https://github.com/feldmannn/webcash-mcp.git
cd webcash-mcp
npm install
npm run build
node dist/cli.js
```

Run via tsx without building:

```bash
npm run dev
```

Run the test suite:

```bash
npm test
```

## Relationship to x402-webcash

`x402-webcash` is the protocol library — it implements the HTTP 402 / webcash payment scheme. `webcash-mcp` is a thin MCP wrapper around it: `pay_fetch` and the wallet tools delegate to `x402-webcash`'s `FileWallet` and `wrapFetchWithWebcash`; `pay_tool` runs the x402-over-MCP dance defined by [`@feldmannn/x402-mcp`](https://www.npmjs.com/package/@feldmannn/x402-mcp) (seller side) and pays with webcash. If you're building a non-MCP client (a CLI, a server middleware, a different transport), use `x402-webcash` directly instead.

## License

MIT
