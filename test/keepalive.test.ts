/** Keep-alive pinger (src/keepalive.ts) and its config defaults. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { startKeepalive } from "../src/keepalive.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("keepalive pinger", () => {
  it("GETs the URL every interval, survives failures, and stops", async () => {
    let hits = 0;
    let fail = true;
    const server = createServer((req, res) => {
      hits += 1;
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/health");
      res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      fail = false; // first ping fails, later ones succeed
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;

    const stop = startKeepalive({ url, intervalMs: 40, timeoutMs: 500 });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    const afterStop = hits;
    await new Promise((r) => setTimeout(r, 120));
    server.close();

    assert.ok(afterStop >= 3, `expected >= 3 pings, got ${afterStop}`);
    assert.equal(hits, afterStop, "no pings after stop()");
  });

  it("an unreachable URL never throws", async () => {
    const stop = startKeepalive({ url: "http://127.0.0.1:1/health", intervalMs: 20, timeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 80));
    stop();
  });
});

describe("keepalive config", () => {
  const base = { ENV: "TEST", INTERNAL_TOKEN: undefined };

  it("off by default when not on Render", () => {
    withEnv({ ...base, RENDER_EXTERNAL_URL: undefined, KEEPALIVE_URL: undefined }, () => {
      assert.equal(loadConfig().keepaliveUrl, undefined);
    });
  });

  it("on Render: defaults to RENDER_EXTERNAL_URL + /health, every 10 min", () => {
    withEnv({ ...base, RENDER_EXTERNAL_URL: "https://osrm-bff.onrender.com/", KEEPALIVE_URL: undefined, KEEPALIVE_INTERVAL_MS: undefined }, () => {
      const c = loadConfig();
      assert.equal(c.keepaliveUrl, "https://osrm-bff.onrender.com/health");
      assert.equal(c.keepaliveIntervalMs, 600_000);
    });
  });

  it('KEEPALIVE_URL overrides it; "none" turns it off', () => {
    withEnv({ ...base, RENDER_EXTERNAL_URL: "https://x.onrender.com", KEEPALIVE_URL: "https://example.test/health" }, () => {
      assert.equal(loadConfig().keepaliveUrl, "https://example.test/health");
    });
    withEnv({ ...base, RENDER_EXTERNAL_URL: "https://x.onrender.com", KEEPALIVE_URL: "none" }, () => {
      assert.equal(loadConfig().keepaliveUrl, undefined);
    });
  });
});
