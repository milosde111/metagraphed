import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import * as listQuery from "../workers/list-query.ts";
import {
  applyGlobalIncidentsListQuery,
  GLOBAL_INCIDENTS_LIST_INPUT_PROPERTIES,
  GLOBAL_INCIDENTS_SORT_FIELDS,
  globalIncidentsListParams,
  globalIncidentsMcpError,
  globalIncidentsQueryUrl,
} from "../src/global-incidents-mcp.ts";
import type { Row } from "./row-type.ts";

const SURFACE_ROWS = [
  { netuid: 7, surface_id: "a", incident_count: 1, downtime_ms: 300 },
  { netuid: 7, surface_id: "b", incident_count: 3, downtime_ms: 100 },
  { netuid: 12, surface_id: "c", incident_count: 2, downtime_ms: 900 },
];

const LEDGER = {
  schema_version: 1,
  window: "7d",
  observed_at: "2026-07-01T00:00:00.000Z",
  source: "live-cron-prober",
  summary: { incident_count: 3, affected_surface_count: 3 },
  surfaces: SURFACE_ROWS,
};

describe("global-incidents-mcp", () => {
  test("globalIncidentsMcpError is shaped for MCP toolError handling", () => {
    const err = globalIncidentsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("GLOBAL_INCIDENTS_SORT_FIELDS matches the incidents collection", () => {
    assert.deepEqual(GLOBAL_INCIDENTS_SORT_FIELDS, [
      "downtime_ms",
      "incident_count",
      "netuid",
      "surface_id",
    ]);
    assert.deepEqual(
      GLOBAL_INCIDENTS_LIST_INPUT_PROPERTIES.sort.enum,
      GLOBAL_INCIDENTS_SORT_FIELDS,
    );
  });

  test("globalIncidentsQueryUrl validates filters and cursor", () => {
    const url = globalIncidentsQueryUrl({
      netuid: 7,
      sort: "downtime_ms",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("sort"), "downtime_ms");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("globalIncidentsListParams is a flat string map of the query URL", () => {
    assert.deepEqual(
      globalIncidentsListParams({
        netuid: 12,
        limit: 1,
        sort: "incident_count",
        order: "asc",
      }),
      {
        netuid: "12",
        limit: "1",
        sort: "incident_count",
        order: "asc",
      },
    );
  });

  test("globalIncidentsQueryUrl rejects invalid sort", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ sort: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects out-of-range limit", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => globalIncidentsQueryUrl({ limit: 1001 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects negative cursor and netuid", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => globalIncidentsQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects non-integer netuid/limit/cursor", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ netuid: "7" }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => globalIncidentsQueryUrl({ limit: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => globalIncidentsQueryUrl({ cursor: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
    assert.throws(
      () => globalIncidentsQueryUrl({ order: "sideways" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl ignores empty optional enum strings", () => {
    const url = globalIncidentsQueryUrl({ sort: "", order: "" });
    assert.equal(url.searchParams.get("sort"), null);
    assert.equal(url.searchParams.get("order"), null);
  });

  test("applyGlobalIncidentsListQuery filters by netuid", () => {
    const out = applyGlobalIncidentsListQuery(LEDGER, { netuid: 12 });
    assert.deepEqual(
      out.surfaces.map((s) => s.netuid),
      [12],
    );
    assert.equal(out.total, 1);
    assert.equal(out.returned, 1);
    assert.equal(out.window, "7d");
  });

  test("applyGlobalIncidentsListQuery paginates the surfaces ledger", () => {
    const page0 = applyGlobalIncidentsListQuery(LEDGER, {
      limit: 1,
      sort: "downtime_ms",
      order: "desc",
    });
    assert.equal(page0.surfaces.length, 1);
    assert.equal(page0.surfaces[0].surface_id, "c");
    assert.equal(page0.total, 3);
    assert.equal(page0.limit, 1);
    assert.equal(page0.cursor, 0);
    assert.equal(page0.next_cursor, 1);
    assert.equal(page0.sort, "downtime_ms");
    assert.equal(page0.order, "desc");

    const page1 = applyGlobalIncidentsListQuery(LEDGER, {
      limit: 1,
      cursor: 1,
      sort: "downtime_ms",
      order: "desc",
    });
    assert.equal(page1.surfaces[0].surface_id, "a");
    assert.equal(page1.cursor, 1);
    assert.equal(page1.next_cursor, 2);
  });

  test("applyGlobalIncidentsListQuery tolerates a missing surfaces array", () => {
    const out = applyGlobalIncidentsListQuery(
      { schema_version: 1, marker: "from-postgres" },
      { limit: 1 },
    );
    assert.equal(out.marker, "from-postgres");
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
  });

  test("applyGlobalIncidentsListQuery tolerates a null ledger", () => {
    const out = applyGlobalIncidentsListQuery(null, {});
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
  });

  test("applyGlobalIncidentsListQuery surfaces applyQueryFilters errors", () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      error: { parameter: "sort", message: "sort is not supported." },
    });
    try {
      assert.throws(
        () => applyGlobalIncidentsListQuery(LEDGER, {}),
        (err: Row) =>
          err.code === "invalid_params" &&
          /sort is not supported/.test(String(err.message)),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("applyGlobalIncidentsListQuery falls back when data/meta are absent", () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({});
    try {
      const out = applyGlobalIncidentsListQuery(LEDGER, { limit: 1 });
      assert.equal(out.total, 3);
      assert.equal(out.returned, 3);
      assert.equal(out.limit, 3);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
    } finally {
      spy.mockRestore();
    }
  });
});
