// The wire-protocol constants for x402-over-MCP are duplicated across
// x402-mcp (seller side) and webcash-mcp (buyer side) on purpose — the
// alternative would be a runtime dep from this package on x402-mcp, which
// we don't want since webcash-mcp can pay any x402-mcp seller without
// needing x402-mcp's seller code installed.
//
// The trade-off: nothing prevents the two copies from drifting apart.
// This test imports both and asserts byte-equality. If we ever change
// the dialect, the test fails until BOTH packages are updated together.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  X402_PAYMENT_META_KEY as BUYER_PAYMENT_KEY,
  X402_CHALLENGE_META_KEY as BUYER_CHALLENGE_KEY,
} from "../src/pay-tool.js";
import {
  X402_PAYMENT_META_KEY as SELLER_PAYMENT_KEY,
  X402_CHALLENGE_META_KEY as SELLER_CHALLENGE_KEY,
} from "x402-mcp";

test("buyer and seller agree on the X402_PAYMENT_META_KEY wire constant", () => {
  assert.equal(
    BUYER_PAYMENT_KEY,
    SELLER_PAYMENT_KEY,
    `dialect drift: webcash-mcp uses "${BUYER_PAYMENT_KEY}" but x402-mcp uses "${SELLER_PAYMENT_KEY}". ` +
      `If you intended to change the dialect, update both packages together and bump majors.`,
  );
});

test("buyer and seller agree on the X402_CHALLENGE_META_KEY wire constant", () => {
  assert.equal(
    BUYER_CHALLENGE_KEY,
    SELLER_CHALLENGE_KEY,
    `dialect drift: webcash-mcp uses "${BUYER_CHALLENGE_KEY}" but x402-mcp uses "${SELLER_CHALLENGE_KEY}". ` +
      `If you intended to change the dialect, update both packages together and bump majors.`,
  );
});
