import { createHash, randomBytes } from "crypto";
import { link, lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from "fs/promises";
import { homedir, userInfo } from "os";
import { dirname, isAbsolute, join } from "path";
import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { discoverArcFlows } from "./arc";
import { parsePipeline } from "./pipeline";

export const SAVED_FLOW_NAME = /^F_[A-Z0-9_]{1,64}$/;
export const SAVED_FLOW_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const FLOW_CONTENT_SHA256 = /^[0-9a-f]{64}$/;

export interface SavedFlowProvenance {
  origin: "conversation" | "cli";
  conversation: string | null;
  exchange: string | null;
  request_id: string;
  saved_at: string;
  saved_by: string;
}

export interface SavedFlowFinding {
  rule: string;
  message: string;
}

export type SaveFlowResult =
  | { status: "saved"; name: string; path: string; sha256: string }
  | { status: "exists"; name: string; path: string; sha256: string }
  | { status: "conflict"; reason: string }
  | { status: "invalid"; findings: SavedFlowFinding[] }
  | { status: "unreadable"; reason: string };

export interface FlowRecord {
  name: string;
  path: string;
  source: "saved" | "arc";
  sha256: string;
  provenance: SavedFlowProvenance | null;
  yaml: string;
}

export type ShowFlowResult =
  | ({ status: "found" } & FlowRecord)
  | { status: "not-found" }
  | { status: "unreadable"; reason: string };

export interface ListedFlow {
  name: string;
  source: "saved" | "arc";
  path: string;
  package: string | null;
  sha256: string | null;
  provenance: SavedFlowProvenance | null;
}

export type ListFlowsResult =
  | { status: "ok"; flows: ListedFlow[] }
  | { status: "unreadable"; reason: string };

export interface SavedFlowLocation {
  flowsDir?: string;
  reposDir?: string;
}

export type DeleteFlowResult =
  | { status: "deleted"; name: string; sha256: string }
  | { status: "absent"; name: string }
  | { status: "conflict"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "invalid"; findings: SavedFlowFinding[] }
  | { status: "unreadable"; reason: string };

export interface DeleteFlowRequest extends SavedFlowLocation {
  name: string;
  expectedSha256: string;
}

export interface SaveFlowRequest extends SavedFlowLocation {
  yaml: string;
  requestId: string;
  conversation?: string;
  exchange?: string;
  savedBy?: string;
  now?: () => Date;
}

class Unreadable extends Error {}

export function defaultFlowsDir(env: Record<string, string | undefined> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(configHome, "pulse", "flows");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonical((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

export function flowContentHash(document: Record<string, unknown>): string {
  const { provenance: _provenance, ...content } = document;
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

interface SavedFlowFile {
  name: string;
  path: string;
  yaml: string;
  sha256: string;
  provenance: SavedFlowProvenance | null;
}

async function readYamlFile(path: string, label: string): Promise<{ yaml: string; document: Record<string, unknown> }> {
  let yaml: string;
  let document: unknown;
  try {
    yaml = await readFile(path, "utf8");
    document = parseYaml(yaml);
  } catch (error) {
    throw new Unreadable(`The ${label} ${path} cannot be read or parsed: ${errorText(error)}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Unreadable(`The ${label} ${path} is not a YAML mapping.`);
  }
  return { yaml, document: document as Record<string, unknown> };
}

function toUnreadable(error: unknown): { status: "unreadable"; reason: string } {
  return { status: "unreadable", reason: errorText(error) };
}

async function writeExclusive(dir: string, name: string, content: string): Promise<"written" | "exists"> {
  const target = join(dir, `${name}.yaml`);
  const temporary = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await link(temporary, target);
    return "written";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) console.error(`pulse: could not remove temporary file ${temporary}: ${errorText(error)}`);
    });
  }
}

async function readSavedFlows(flowsDir: string): Promise<SavedFlowFile[]> {
  let entries: string[];
  try {
    entries = await readdir(flowsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Unreadable(`The flows directory ${flowsDir} cannot be read: ${errorText(error)}`);
  }
  const flows: SavedFlowFile[] = [];
  for (const entry of entries.sort()) {
    const name = entry.endsWith(".yaml") ? entry.slice(0, -".yaml".length) : "";
    if (!SAVED_FLOW_NAME.test(name)) continue;
    const path = join(flowsDir, entry);
    const { yaml, document } = await readYamlFile(path, "saved flow");
    if (document.name !== name) {
      throw new Unreadable(`The saved flow ${path} names ${String(document.name)}, not ${name}.`);
    }
    const provenance = document.provenance && typeof document.provenance === "object" ? document.provenance as SavedFlowProvenance : null;
    flows.push({ name, path, yaml, sha256: flowContentHash(document), provenance });
  }
  return flows;
}

async function arcFlowNames(reposDir: string | undefined): Promise<Array<{ name: string; packageName: string; path: string }>> {
  const flows = reposDir === undefined ? await discoverArcFlows() : await discoverArcFlows(reposDir);
  return flows.map((flow) => ({ name: flow.flow.name, packageName: flow.packageName, path: flow.yamlPath }));
}

function validateInput(yaml: string, requestId: string, flowsDir: string): { findings: SavedFlowFinding[]; document?: Record<string, unknown> } {
  const findings: SavedFlowFinding[] = [];
  if (!isAbsolute(flowsDir)) findings.push({ rule: "flows-dir", message: `The flows directory must be an absolute path: ${flowsDir}` });
  if (!SAVED_FLOW_REQUEST_ID.test(requestId)) findings.push({ rule: "request-id", message: "The request ID must be 8 to 64 letters, digits, underscores or hyphens." });
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (error) {
    findings.push({ rule: "parse-error", message: errorText(error) });
    return { findings };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    findings.push({ rule: "parse-error", message: "The flow is not a YAML mapping." });
    return { findings };
  }
  const document = parsed as Record<string, unknown>;
  if (typeof document.name !== "string" || !SAVED_FLOW_NAME.test(document.name)) {
    findings.push({ rule: "name", message: `The flow name must match ${SAVED_FLOW_NAME.source}.` });
  }
  if ("provenance" in document) findings.push({ rule: "provenance", message: "The input must not have a provenance key; only save writes provenance." });
  if ("schedule" in document) findings.push({ rule: "schedule", message: "The input must not have a schedule key; a saved flow is never scheduled." });
  try {
    parsePipeline(yaml);
  } catch (error) {
    findings.push({ rule: "pipeline", message: errorText(error) });
  }
  return findings.length > 0 ? { findings } : { findings, document };
}

function withProvenance(yaml: string, document: Record<string, unknown>, provenance: SavedFlowProvenance): string | undefined {
  const expected = flowContentHash(document);
  const block = stringifyYaml({ provenance });
  const appended = `${yaml.endsWith("\n") ? yaml : `${yaml}\n`}${block}`;
  if (matches(appended, expected, provenance)) return appended;
  const edited = parseDocument(yaml);
  if (!isMap(edited.contents)) return undefined;
  edited.set("provenance", provenance);
  const rewritten = edited.toString();
  return matches(rewritten, expected, provenance) ? rewritten : undefined;
}

function matches(text: string, expectedHash: string, provenance: SavedFlowProvenance): boolean {
  try {
    const reparsed = parseYaml(text) as Record<string, unknown>;
    return flowContentHash(reparsed) === expectedHash && JSON.stringify(canonical(reparsed.provenance)) === JSON.stringify(canonical(provenance));
  } catch (_err) {
    return false;
  }
}

function resolveSavedBy(savedBy: string | undefined): string {
  if (savedBy) return savedBy;
  if (process.env.PULSE_PRINCIPAL) return process.env.PULSE_PRINCIPAL;
  return userInfo().username;
}

function existingOutcome(flows: SavedFlowFile[], requestId: string, sha256: string): SaveFlowResult | undefined {
  const prior = flows.find((flow) => flow.provenance?.request_id === requestId);
  if (!prior) return undefined;
  if (prior.sha256 === sha256) return { status: "exists", name: prior.name, path: prior.path, sha256 };
  return { status: "conflict", reason: `Request ${requestId} already saved ${prior.name} with different content.` };
}

export async function saveFlow(request: SaveFlowRequest): Promise<SaveFlowResult> {
  const flowsDir = request.flowsDir ?? defaultFlowsDir();
  const { findings, document } = validateInput(request.yaml, request.requestId, flowsDir);
  if (!document) return { status: "invalid", findings };
  const name = document.name as string;
  const sha256 = flowContentHash(document);
  try {
    const saved = await readSavedFlows(flowsDir);
    const prior = existingOutcome(saved, request.requestId, sha256);
    if (prior) return prior;
    if (saved.some((flow) => flow.name === name)) {
      return { status: "conflict", reason: `A saved flow is already named ${name}.` };
    }
    const arc = (await arcFlowNames(request.reposDir)).find((flow) => flow.name === name);
    if (arc) return { status: "conflict", reason: `The arc package ${arc.packageName} already installs a flow named ${name}.` };

    const provenance: SavedFlowProvenance = {
      origin: request.conversation ? "conversation" : "cli",
      conversation: request.conversation ?? null,
      exchange: request.exchange ?? null,
      request_id: request.requestId,
      saved_at: (request.now ?? (() => new Date()))().toISOString(),
      saved_by: resolveSavedBy(request.savedBy),
    };
    const content = withProvenance(request.yaml, document, provenance);
    if (content === undefined) {
      return { status: "invalid", findings: [{ rule: "parse-error", message: "The flow cannot take a top-level provenance mapping." }] };
    }

    await mkdir(flowsDir, { recursive: true, mode: 0o700 });
    const realDir = await realpath(flowsDir);
    if (dirname(join(realDir, `${name}.yaml`)) !== realDir) {
      return { status: "invalid", findings: [{ rule: "name", message: "The flow file would land outside the flows directory." }] };
    }
    if (await writeExclusive(realDir, name, content) === "exists") {
      const raced = existingOutcome(await readSavedFlows(flowsDir), request.requestId, sha256);
      return raced ?? { status: "conflict", reason: `A saved flow is already named ${name}.` };
    }
    return { status: "saved", name, path: join(flowsDir, `${name}.yaml`), sha256 };
  } catch (error) {
    if (error instanceof Unreadable) return toUnreadable(error);
    throw error;
  }
}

export async function showFlow(query: SavedFlowLocation & ({ name: string } | { requestId: string })): Promise<ShowFlowResult> {
  const flowsDir = query.flowsDir ?? defaultFlowsDir();
  try {
    const saved = await readSavedFlows(flowsDir);
    if ("requestId" in query) {
      const hit = saved.find((flow) => flow.provenance?.request_id === query.requestId);
      return hit ? { status: "found", source: "saved", ...hit } : { status: "not-found" };
    }
    const own = saved.find((flow) => flow.name === query.name);
    if (own) return { status: "found", source: "saved", ...own };
    const arc = await readArcFlowNamed(query.reposDir, query.name);
    return arc ? { status: "found", ...arc } : { status: "not-found" };
  } catch (error) {
    return toUnreadable(error);
  }
}

async function readArcFlowNamed(reposDir: string | undefined, name: string): Promise<FlowRecord | undefined> {
  const match = (await arcFlowNames(reposDir)).find((flow) => flow.name === name);
  if (!match) return undefined;
  const { yaml, document } = await readYamlFile(match.path, "arc flow");
  return { name, path: match.path, source: "arc", sha256: flowContentHash(document), provenance: null, yaml };
}

export async function listFlows(location: SavedFlowLocation = {}): Promise<ListFlowsResult> {
  const flowsDir = location.flowsDir ?? defaultFlowsDir();
  try {
    const saved = await readSavedFlows(flowsDir);
    const arc = await arcFlowNames(location.reposDir);
    return {
      status: "ok",
      flows: [
        ...saved.map((flow) => ({ name: flow.name, source: "saved" as const, path: flow.path, package: null, sha256: flow.sha256, provenance: flow.provenance })),
        ...arc.map((flow) => ({ name: flow.name, source: "arc" as const, path: flow.path, package: flow.packageName, sha256: null, provenance: null })),
      ],
    };
  } catch (error) {
    return toUnreadable(error);
  }
}

function validateDelete(request: DeleteFlowRequest, flowsDir: string): SavedFlowFinding[] {
  const findings: SavedFlowFinding[] = [];
  if (!isAbsolute(flowsDir)) findings.push({ rule: "flows-dir", message: `The flows directory must be an absolute path: ${flowsDir}` });
  if (!SAVED_FLOW_NAME.test(request.name)) findings.push({ rule: "name", message: `The flow name must match ${SAVED_FLOW_NAME.source}.` });
  if (!FLOW_CONTENT_SHA256.test(request.expectedSha256)) {
    findings.push({ rule: "expected-sha256", message: "The expected sha256 must be 64 lowercase hex characters." });
  }
  return findings;
}

async function absentOutcome(name: string, reposDir: string | undefined): Promise<DeleteFlowResult> {
  const arc = (await arcFlowNames(reposDir)).find((flow) => flow.name === name);
  if (arc) return { status: "refused", reason: `${name} is an installed arc flow; remove it with arc.` };
  return { status: "absent", name };
}

async function lstatOrMissing(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Unreadable(`The saved flow ${path} cannot be read: ${errorText(error)}`);
  }
}

export async function deleteFlow(request: DeleteFlowRequest): Promise<DeleteFlowResult> {
  const flowsDir = request.flowsDir ?? defaultFlowsDir();
  const findings = validateDelete(request, flowsDir);
  if (findings.length > 0) return { status: "invalid", findings };
  const { name } = request;
  try {
    const dir = await lstatOrMissing(flowsDir);
    if (!dir) return await absentOutcome(name, request.reposDir);
    const realDir = await realpath(flowsDir);
    const target = join(realDir, `${name}.yaml`);
    const file = await lstatOrMissing(target);
    if (!file) return await absentOutcome(name, request.reposDir);
    if (!file.isFile()) {
      return { status: "invalid", findings: [{ rule: "file", message: `${target} is not a regular file inside the flows directory; nothing was deleted.` }] };
    }
    const { document } = await readYamlFile(target, "saved flow");
    if (document.name !== name) throw new Unreadable(`The saved flow ${target} names ${String(document.name)}, not ${name}.`);
    const sha256 = flowContentHash(document);
    if (sha256 !== request.expectedSha256) {
      return { status: "conflict", reason: `The saved flow ${name} has content ${sha256}, not the expected ${request.expectedSha256}; nothing was deleted.` };
    }
    try {
      await unlink(target);
    } catch (error) {
      if (isMissing(error)) return { status: "absent", name };
      throw new Unreadable(`The saved flow ${target} cannot be removed: ${errorText(error)}`);
    }
    return { status: "deleted", name, sha256 };
  } catch (error) {
    return toUnreadable(error);
  }
}
