#!/usr/bin/env node
// webcash-mcp stdio entry point. Connects the createServer() factory to a
// StdioServerTransport so MCP clients (Claude Desktop, etc.) can spawn it
// via `npx webcash-mcp`.

import { resolve } from "node:path";
import { FileWallet } from "x402-webcash/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

const walletPath = resolve(process.env.WEBCASH_WALLET ?? "./client-wallet.json");
const wallet = new FileWallet(walletPath);

const server = createServer({ wallet, walletLabel: walletPath });

await server.connect(new StdioServerTransport());

// stderr is the only safe channel under stdio transport — stdout carries
// the MCP protocol traffic.
console.error(`webcash-mcp ${VERSION} ready. wallet=${walletPath}`);
