/**
 * Cursor Gateway client — thin fetch wrapper for TDAI Gateway HTTP routes.
 *
 * Boundary: Bearer + JSON + timeout only. No pending/lock/session logic.
 * Compatible with #316 GatewayMemoryClient contracts without depending on it.
 */

import type { CursorConfig } from "./config.js";

export interface GatewayResult {
  status?: number;
  body?: unknown;
  error?: string;
}

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export async function gatewayRequest(
  route: string,
  body: unknown,
  config: CursorConfig,
  fetchImpl: FetchLike = fetch,
): Promise<GatewayResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.gatewayApiKey) {
    headers.Authorization = `Bearer ${config.gatewayApiKey}`;
  }

  try {
    const response = await fetchImpl(
      new URL(route, `${config.gatewayUrl}/`).toString(),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.captureTimeoutMs),
      },
    );
    const raw = (await response.text()).slice(0, 2_048);
    let parsed: unknown = raw;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Non-JSON error bodies stay as a bounded string.
      }
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    return {
      error: (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 300),
    };
  }
}
