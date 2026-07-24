// Global incident list-query helpers for MCP parity on GET /api/v1/incidents.
// Mirrors endpoint-incidents-mcp.ts: validate the same filter/sort/page args the
// REST route accepts on top of `window`, then run them through applyQueryFilters
// over the window-scoped ledger (Postgres tier or cold empty fallback).

import { applyQueryFilters, type Row } from "../workers/list-query.ts";
import { API_QUERY_COLLECTIONS } from "./contracts.ts";

export const GLOBAL_INCIDENTS_SORT_FIELDS =
  API_QUERY_COLLECTIONS.incidents.sort_fields;

export interface GlobalIncidentsMcpError extends Error {
  toolError: true;
  code: string;
}

export function globalIncidentsMcpError(
  code: string,
  message: string,
): GlobalIncidentsMcpError {
  const error = new Error(message) as GlobalIncidentsMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

function optionalEnum(
  args: Record<string, unknown> | null | undefined,
  key: string,
  allowed: string[],
): string | null {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw globalIncidentsMcpError(
      "invalid_params",
      `Argument \`${key}\` must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

/** Build the list-query URL for the incidents collection (no `window` — that is route scope). */
export function globalIncidentsQueryUrl(
  args: Record<string, unknown> | null | undefined,
): URL {
  const url = new URL("https://mcp.internal/incidents");
  if (args?.netuid !== undefined) {
    const netuid = args.netuid;
    if (typeof netuid !== "number" || !Number.isInteger(netuid) || netuid < 0) {
      throw globalIncidentsMcpError(
        "invalid_params",
        "netuid must be a non-negative integer.",
      );
    }
    url.searchParams.set("netuid", String(netuid));
  }
  const sort = optionalEnum(args, "sort", GLOBAL_INCIDENTS_SORT_FIELDS);
  if (sort) url.searchParams.set("sort", sort);
  const order = optionalEnum(args, "order", ["asc", "desc"]);
  if (order) url.searchParams.set("order", order);
  if (args?.limit !== undefined) {
    const limit = args.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw globalIncidentsMcpError(
        "invalid_params",
        "limit must be an integer between 1 and 1000.",
      );
    }
    url.searchParams.set("limit", String(limit));
  }
  if (args?.cursor !== undefined) {
    const cursor = args.cursor;
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      throw globalIncidentsMcpError(
        "invalid_params",
        "cursor must be a non-negative integer.",
      );
    }
    url.searchParams.set("cursor", String(cursor));
  }
  return url;
}

/** Flat query params to forward on the Postgres-tier /api/v1/incidents request. */
export function globalIncidentsListParams(
  args: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of globalIncidentsQueryUrl(args).searchParams) {
    params[key] = value;
  }
  return params;
}

export interface GlobalIncidentsListResult extends Row {
  surfaces: Row[];
  total: unknown;
  returned: unknown;
  limit: unknown;
  cursor: unknown;
  next_cursor: unknown;
  sort: unknown;
  order: unknown;
}

/**
 * Apply the incidents list-query transform to a formatGlobalIncidents ledger
 * and flatten pagination onto the payload the way list_endpoint_incidents does.
 */
export function applyGlobalIncidentsListQuery(
  ledger: Record<string, unknown> | null | undefined,
  args: Record<string, unknown> | null | undefined,
): GlobalIncidentsListResult {
  const blob =
    ledger && typeof ledger === "object"
      ? ledger
      : ({ surfaces: [] } as Record<string, unknown>);
  const queryUrl = globalIncidentsQueryUrl(args);
  const transformed = applyQueryFilters(blob, queryUrl, "incidents", []);
  if (transformed.error) {
    throw globalIncidentsMcpError("invalid_params", transformed.error.message);
  }
  const data = (transformed.data ?? blob) as Record<string, unknown>;
  const meta = (transformed.meta ?? {}) as Record<string, unknown>;
  const page = (meta.pagination as Record<string, unknown>) || {};
  const rows = Array.isArray(data.surfaces) ? (data.surfaces as Row[]) : [];
  const rowLen = rows.length;
  return {
    ...data,
    surfaces: rows,
    total: page.total ?? rowLen,
    returned: page.returned ?? rowLen,
    limit: page.limit ?? rowLen,
    cursor: page.cursor ?? 0,
    next_cursor: page.next_cursor ?? null,
    sort: page.sort ?? null,
    order: page.order ?? null,
  };
}

/** Shared inputSchema.properties for netuid/limit/cursor/sort/order (plus callers add window). */
export const GLOBAL_INCIDENTS_LIST_INPUT_PROPERTIES = {
  netuid: {
    type: "integer",
    description: "Filter to one subnet netuid.",
    minimum: 0,
  },
  sort: {
    type: "string",
    enum: GLOBAL_INCIDENTS_SORT_FIELDS,
    description: "Field to sort surfaces by before paging.",
  },
  order: {
    type: "string",
    enum: ["asc", "desc"],
    description: "Sort direction for sort (default asc).",
  },
  limit: {
    type: "integer",
    description: "Max surface rows to return (1-1000). Enables pagination.",
    minimum: 1,
    maximum: 1000,
  },
  cursor: {
    type: "integer",
    description: "Pagination cursor from a prior response's next_cursor.",
    minimum: 0,
  },
} as const;
