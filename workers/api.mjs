const CONTRACT_VERSION = "2026-06-06.1";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const ROUTES = [
  route(/^\/api\/v1\/?$/, "/metagraph/api-index.json", "standard"),
  route(/^\/api\/v1\/subnets\/?$/, "/metagraph/subnets.json", "standard"),
  route(/^\/api\/v1\/subnets\/(?<netuid>\d+)\/?$/, ({ netuid }) => `/metagraph/subnets/${netuid}.json`, "standard"),
  route(/^\/api\/v1\/surfaces\/?$/, "/metagraph/surfaces.json", "standard"),
  route(/^\/api\/v1\/candidates\/?$/, "/metagraph/candidates.json", "standard"),
  route(/^\/api\/v1\/providers\/?$/, "/metagraph/providers.json", "standard"),
  route(/^\/api\/v1\/coverage\/?$/, "/metagraph/coverage.json", "standard"),
  route(/^\/api\/v1\/curation\/?$/, "/metagraph/curation.json", "standard"),
  route(/^\/api\/v1\/gaps\/?$/, "/metagraph/gaps.json", "standard"),
  route(/^\/api\/v1\/health\/?$/, "/metagraph/health/summary.json", "short"),
  route(/^\/api\/v1\/freshness\/?$/, "/metagraph/freshness.json", "short"),
  route(/^\/api\/v1\/source-health\/?$/, "/metagraph/source-health.json", "short"),
  route(/^\/api\/v1\/evidence\/?$/, "/metagraph/evidence-ledger.json", "standard"),
  route(/^\/api\/v1\/changelog\/?$/, "/metagraph/changelog.json", "short"),
  route(/^\/api\/v1\/source-snapshots\/?$/, "/metagraph/source-snapshots.json", "standard"),
  route(/^\/api\/v1\/rpc\/endpoints\/?$/, "/metagraph/rpc-endpoints.json", "short"),
  route(/^\/api\/v1\/rpc\/pools\/?$/, "/metagraph/rpc/pools.json", "short"),
  route(/^\/api\/v1\/schemas\/?$/, "/metagraph/schemas/index.json", "standard"),
  route(/^\/api\/v1\/adapters\/(?<slug>[a-z0-9-]+)\/?$/, ({ slug }) => `/metagraph/adapters/${slug}.json`, "short"),
  route(/^\/api\/v1\/search\/?$/, "/metagraph/search.json", "standard"),
  route(/^\/api\/v1\/contracts\/?$/, "/metagraph/contracts.json", "standard"),
  route(/^\/api\/v1\/build\/?$/, "/metagraph/build-summary.json", "short")
];

const CACHE_SECONDS = {
  short: 60,
  standard: 300,
  static: 600
};

const SAFE_RPC_METHODS = new Set(["chain_getHeader", "chain_getBlockHash", "system_health", "rpc_methods"]);
const DENIED_RPC_PREFIXES = ["author_", "state_call", "sudo_", "payment_", "contracts_"];
const MAX_RPC_BODY_BYTES = 65536;
const METAGRAPH_LATEST_KEY = "metagraph:latest";

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight();
  }

  if (url.pathname.startsWith("/rpc/v1/")) {
    return handleRpcProxyRequest(request, env, url);
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse("method_not_allowed", "Only GET, HEAD, and OPTIONS are supported.", 405);
  }

  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    return handleApiRequest(request, env, url);
  }

  if (env.ASSETS?.fetch) {
    return env.ASSETS.fetch(request);
  }

  return errorResponse("not_found", "No static asset binding is configured for this route.", 404);
}

async function handleApiRequest(request, env, url) {
  const matched = matchRoute(url.pathname);
  if (!matched) {
    return errorResponse("not_found", "No API route matched this path.", 404);
  }

  const artifact = await readArtifact(env, matched.artifactPath);
  if (!artifact.ok) {
    return errorResponse(artifact.code, artifact.message, artifact.status, {
      artifact_path: matched.artifactPath
    });
  }

  const data = applyQueryFilters(artifact.data, url);
  return envelopeResponse(request, {
    data,
    meta: {
      artifact_path: matched.artifactPath,
      cache: matched.cache,
      contract_version: contractVersion(env),
      generated_at: artifact.data?.generated_at || null,
      source: artifact.source
    }
  }, matched.cache);
}

async function handleRpcProxyRequest(request, env, url) {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "The RPC proxy only accepts POST requests.", 405);
  }

  if (env.METAGRAPH_ENABLE_RPC_PROXY !== "true") {
    return errorResponse(
      "rpc_proxy_disabled",
      "Read-only RPC proxying is intentionally disabled until endpoint scoring, abuse controls, and method filtering are enabled.",
      501
    );
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_RPC_BODY_BYTES) {
    return errorResponse("rpc_body_too_large", "RPC request body is too large for the read-only proxy.", 413);
  }

  let bodyText;
  let rpcBody;
  try {
    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_RPC_BODY_BYTES) {
      return errorResponse("rpc_body_too_large", "RPC request body is too large for the read-only proxy.", 413);
    }
    rpcBody = JSON.parse(bodyText);
  } catch {
    return errorResponse("rpc_invalid_json", "RPC request body must be a JSON object.", 400);
  }

  if (!rpcBody || Array.isArray(rpcBody) || typeof rpcBody !== "object" || typeof rpcBody.method !== "string") {
    return errorResponse("rpc_invalid_request", "Only single JSON-RPC request objects are supported.", 400);
  }

  if (!isSafeRpcMethod(rpcBody.method)) {
    return errorResponse("rpc_method_blocked", `RPC method is not allowed through this proxy: ${rpcBody.method}`, 403, {
      allowed_methods: [...SAFE_RPC_METHODS].sort()
    });
  }

  const poolArtifact = await readArtifact(env, "/metagraph/rpc/pools.json");
  if (!poolArtifact.ok) {
    return errorResponse(poolArtifact.code, poolArtifact.message, poolArtifact.status, {
      artifact_path: "/metagraph/rpc/pools.json"
    });
  }

  const poolId = url.pathname.includes("/wss") ? "finney-wss" : "finney-rpc";
  const pool = (poolArtifact.data.pools || []).find((candidate) => candidate.id === poolId);
  const endpoint = pool?.endpoints?.find((candidate) => candidate.pool_eligible);
  if (!endpoint) {
    return errorResponse("rpc_endpoint_unavailable", "No eligible public RPC endpoint is available for proxy routing.", 503, {
      pool_id: poolId
    });
  }

  const upstream = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: bodyText,
    signal: AbortSignal.timeout(10000)
  });
  const headers = apiHeaders("short");
  headers.set("cache-control", "no-store");
  headers.set("x-metagraph-rpc-endpoint-id", endpoint.id);
  headers.set("x-metagraph-rpc-provider", endpoint.provider);
  return new Response(upstream.body, {
    status: upstream.status,
    headers
  });
}

function matchRoute(pathname) {
  for (const candidate of ROUTES) {
    const match = candidate.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const params = match.groups || {};
    return {
      artifactPath: typeof candidate.artifactPath === "function" ? candidate.artifactPath(params) : candidate.artifactPath,
      cache: candidate.cache,
      params
    };
  }
  return null;
}

async function readArtifact(env, artifactPath) {
  const asset = await readAsset(env, artifactPath);
  if (asset.ok) {
    return asset;
  }

  const r2 = await readR2(env, artifactPath);
  if (r2.ok) {
    return r2;
  }

  return asset.status !== 404 ? asset : r2;
}

async function readAsset(env, artifactPath) {
  if (!env.ASSETS?.fetch) {
    return { ok: false, status: 404, code: "asset_binding_missing", message: "No ASSETS binding is configured." };
  }

  const response = await env.ASSETS.fetch(new Request(`https://assets.local${artifactPath}`));
  if (!response.ok) {
    await response.body?.cancel?.();
    return {
      ok: false,
      status: response.status,
      code: "artifact_not_found",
      message: `Artifact not found in static assets: ${artifactPath}`
    };
  }

  return {
    ok: true,
    data: await response.json(),
    source: "static-assets"
  };
}

async function readR2(env, artifactPath) {
  if (!env.METAGRAPH_ARCHIVE?.get) {
    return { ok: false, status: 404, code: "r2_binding_missing", message: "No R2 archive binding is configured." };
  }

  const key = await latestR2Key(artifactPath, env);
  const object = await env.METAGRAPH_ARCHIVE.get(key);
  if (!object) {
    return {
      ok: false,
      status: 404,
      code: "artifact_not_found",
      message: `Artifact not found in R2: ${key}`
    };
  }

  return {
    ok: true,
    data: await object.json(),
    source: "r2"
  };
}

async function latestR2Key(artifactPath, env) {
  const pointer = await latestPointer(env);
  const prefix = pointer?.latest_prefix || env.METAGRAPH_R2_LATEST_PREFIX || "latest/";
  return `${prefix}${artifactPath.replace(/^\/metagraph\//, "")}`;
}

async function latestPointer(env) {
  if (!env.METAGRAPH_CONTROL?.get) {
    return null;
  }

  try {
    return await env.METAGRAPH_CONTROL.get(METAGRAPH_LATEST_KEY, { type: "json" });
  } catch {
    return null;
  }
}

function applyQueryFilters(data, url) {
  const params = url.searchParams;
  if (Array.isArray(data?.subnets)) {
    return {
      ...data,
      subnets: filterRows(data.subnets, params, ["netuid", "coverage_level", "curation_level", "status", "subnet_type"])
    };
  }
  if (Array.isArray(data?.surfaces)) {
    return {
      ...data,
      surfaces: filterRows(data.surfaces, params, ["netuid", "kind", "provider", "status", "classification"])
    };
  }
  if (Array.isArray(data?.providers)) {
    return {
      ...data,
      providers: filterRows(data.providers, params, ["id", "kind", "authority"])
    };
  }
  if (Array.isArray(data?.candidates)) {
    return {
      ...data,
      candidates: filterRows(data.candidates, params, ["netuid", "kind", "provider", "state"])
    };
  }
  if (Array.isArray(data?.curation)) {
    return {
      ...data,
      curation: filterRows(data.curation, params, ["netuid", "coverage_level"])
    };
  }
  if (Array.isArray(data?.gaps)) {
    return {
      ...data,
      gaps: filterRows(data.gaps, params, ["netuid", "coverage_level", "curation_level"])
    };
  }
  if (Array.isArray(data?.claims) && params.get("q")) {
    const q = params.get("q").toLowerCase();
    return {
      ...data,
      claims: data.claims.filter((claim) =>
        [claim.subject, claim.claim, claim.source_url, claim.support_summary]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
    };
  }
  if (Array.isArray(data?.documents) && params.get("q")) {
    const q = params.get("q").toLowerCase();
    return {
      ...data,
      documents: data.documents.filter((document) =>
        [document.title, document.subtitle, document.slug, ...(document.tokens || [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
    };
  }
  return data;
}

function filterRows(rows, params, keys) {
  return rows.filter((row) =>
    keys.every((key) => {
      if (!params.has(key)) {
        return true;
      }
      return String(row[key]) === params.get(key);
    })
  );
}

async function envelopeResponse(request, payload, cacheProfile) {
  const body = JSON.stringify({
    ok: true,
    schema_version: 1,
    data: payload.data,
    meta: payload.meta
  });
  const headers = apiHeaders(cacheProfile);
  const etag = await weakEtag(body);
  headers.set("etag", etag);
  headers.set("x-metagraph-contract-version", payload.meta.contract_version || CONTRACT_VERSION);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers
    });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers
  });
}

function errorResponse(code, message, status = 500, meta = {}) {
  return new Response(JSON.stringify({
    ok: false,
    schema_version: 1,
    data: null,
    error: { code, message },
    meta: {
      contract_version: CONTRACT_VERSION,
      ...meta
    }
  }), {
    status,
    headers: apiHeaders("short")
  });
}

function corsPreflight() {
  const headers = apiHeaders("short");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, if-none-match");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

function apiHeaders(cacheProfile) {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", `public, max-age=${CACHE_SECONDS[cacheProfile] || CACHE_SECONDS.standard}, stale-while-revalidate=300`);
  headers.set("content-type", JSON_CONTENT_TYPE);
  headers.set("vary", "Accept-Encoding");
  return headers;
}

async function weakEtag(body) {
  const encoded = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `W/"${hash.slice(0, 32)}"`;
}

function contractVersion(env) {
  return env.METAGRAPH_CONTRACT_VERSION || CONTRACT_VERSION;
}

function isSafeRpcMethod(method) {
  if (DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return false;
  }
  return SAFE_RPC_METHODS.has(method);
}

function route(pattern, artifactPath, cache = "standard") {
  return { pattern, artifactPath, cache };
}
