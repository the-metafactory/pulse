/**
 * Shared harness for the SOC demo block tests — one copy of the
 * ActionContext factory and the env save/restore discipline, so changes to
 * context shape or env cleanup happen in one place (sage PR #40).
 */

import type { ActionContext } from "../../src/types/action";

export function ctxWith(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>): ActionContext {
  return {
    capabilities: { fetch: fetchImpl as typeof globalThis.fetch },
    env: {},
    meta: { actionName: "test", startedAt: new Date().toISOString(), mode: "local" },
  } as unknown as ActionContext;
}

const SAVED_ENV: Record<string, string | undefined> = {};

export function setEnv(key: string, value: string | undefined) {
  if (!(key in SAVED_ENV)) SAVED_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Register as afterEach(restoreEnv) in every file using setEnv. */
export function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(SAVED_ENV)) delete SAVED_ENV[key];
}
