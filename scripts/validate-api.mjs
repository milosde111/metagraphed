import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { handleRequest } from "../workers/api.mjs";
import { repoRoot } from "./lib.mjs";

const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const filePath = path.join(repoRoot, "public", url.pathname.replace(/^\/+/, ""));
      try {
        const body = await fs.readFile(filePath);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": filePath.endsWith(".json") ? "application/json" : "application/octet-stream"
          }
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
  }
};

const checks = [
  ["/api/v1", (body) => assert.equal(Array.isArray(body.data.routes), true)],
  ["/api/v1/subnets", (body) => assert.equal(Array.isArray(body.data.subnets), true)],
  ["/api/v1/subnets/7", (body) => assert.equal(body.data.subnet.netuid, 7)],
  ["/api/v1/surfaces?kind=openapi", (body) => assert.equal(body.data.surfaces.every((surface) => surface.kind === "openapi"), true)],
  ["/api/v1/candidates?state=schema-valid", (body) => assert.equal(body.data.candidates.every((candidate) => candidate.state === "schema-valid"), true)],
  ["/api/v1/providers", (body) => assert.equal(Array.isArray(body.data.providers), true)],
  ["/api/v1/coverage", (body) => assert.equal(Number.isInteger(body.data.chain_subnet_count), true)],
  ["/api/v1/curation?coverage_level=probed", (body) => assert.equal(body.data.curation.every((entry) => entry.coverage_level === "probed"), true)],
  ["/api/v1/gaps", (body) => assert.equal(Array.isArray(body.data.gaps), true)],
  ["/api/v1/health", (body) => assert.equal(Array.isArray(body.data.subnets), true)],
  ["/api/v1/freshness", (body) => assert.equal(Boolean(body.data.summary.native_snapshot_captured_at), true)],
  ["/api/v1/source-health", (body) => assert.equal(Array.isArray(body.data.providers), true)],
  ["/api/v1/evidence?q=allways", (body) => assert.equal(Array.isArray(body.data.claims), true)],
  ["/api/v1/changelog", (body) => assert.equal(body.data.source, "generated-artifact-diff")],
  ["/api/v1/source-snapshots", (body) => assert.equal(Array.isArray(body.data.sources), true)],
  ["/api/v1/rpc/endpoints", (body) => assert.equal(Array.isArray(body.data.endpoints), true)],
  ["/api/v1/rpc/pools", (body) => assert.equal(Array.isArray(body.data.pools), true)],
  ["/api/v1/schemas", (body) => assert.equal(Array.isArray(body.data.schemas), true)],
  ["/api/v1/adapters/allways", (body) => assert.equal(body.data.slug, "allways")],
  ["/api/v1/search?q=allways", (body) => assert.equal(body.data.documents.length > 0, true)],
  ["/api/v1/contracts", (body) => assert.equal(body.data.primary_domain, "metagraph.sh")],
  ["/api/v1/build", (body) => assert.equal(Number.isInteger(body.data.artifact_count), true)]
];

for (const [route, assertion] of checks) {
  const response = await handleRequest(new Request(`https://metagraph.sh${route}`), env, {});
  assert.equal(response.status, 200, `${route}: expected 200`);
  assert.equal(response.headers.get("access-control-allow-origin"), "*", `${route}: missing CORS`);
  assert.ok(response.headers.get("etag"), `${route}: missing ETag`);
  assert.equal(response.headers.get("x-metagraph-contract-version"), "2026-06-06.1", `${route}: missing contract header`);
  const body = await response.json();
  assert.equal(body.ok, true, `${route}: expected ok envelope`);
  assert.equal(body.schema_version, 1, `${route}: expected schema_version 1`);
  assertion(body);
}

const etagSource = await handleRequest(new Request("https://metagraph.sh/api/v1/subnets/7"), env, {});
const cached = await handleRequest(
  new Request("https://metagraph.sh/api/v1/subnets/7", {
    headers: {
      "if-none-match": etagSource.headers.get("etag")
    }
  }),
  env,
  {}
);
assert.equal(cached.status, 304, "matching ETag should return 304");

const missing = await handleRequest(new Request("https://metagraph.sh/api/v1/subnets/9999"), env, {});
assert.equal(missing.status, 404, "missing subnet should return 404");
assert.equal((await missing.json()).ok, false, "missing subnet should return error envelope");

const proxy = await handleRequest(new Request("https://metagraph.sh/rpc/v1/finney", { method: "POST" }), env, {});
assert.equal(proxy.status, 501, "RPC proxy should be disabled by default");

const blockedRpc = await handleRequest(
  new Request("https://metagraph.sh/rpc/v1/finney", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "author_submitExtrinsic",
      params: []
    })
  }),
  {
    ...env,
    METAGRAPH_ENABLE_RPC_PROXY: "true"
  },
  {}
);
assert.equal(blockedRpc.status, 403, "unsafe RPC methods must be blocked when proxy flag is enabled");

const r2Fallback = await handleRequest(
  new Request("https://metagraph.sh/api/v1/changelog"),
  {
    ASSETS: {
      async fetch() {
        return new Response("not found", { status: 404 });
      }
    },
    METAGRAPH_CONTROL: {
      async get(key) {
        assert.equal(key, "metagraph:latest");
        return { latest_prefix: "latest/" };
      }
    },
    METAGRAPH_ARCHIVE: {
      async get(key) {
        assert.equal(key, "latest/changelog.json");
        return {
          async json() {
            return {
              schema_version: 1,
              contract_version: "2026-06-06.1",
              generated_at: "1970-01-01T00:00:00.000Z",
              source: "generated-artifact-diff"
            };
          }
        };
      }
    }
  },
  {}
);
assert.equal(r2Fallback.status, 200, "Worker should fall back to R2 with KV latest pointer");

console.log(`Validated ${checks.length} Worker API route(s).`);
