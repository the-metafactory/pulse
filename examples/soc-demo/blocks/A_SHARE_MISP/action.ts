/**
 * A_SHARE_MISP — render and push a MISP event (design/soc-demo-mm-composer.md §4).
 *
 * Stub-safe external adapter, same contract as A_FETCH_VIRUSTOTAL: env-checked
 * at execute time, deterministic rendered response when the credentials are
 * missing. Even in stub mode this is a strong demo story — most of the audience
 * already runs MISP — because the block ALWAYS renders a real MISP Event
 * structure; the only difference is whether it gets POSTed. JC provides real
 * MISP credentials later.
 *
 * The rendered event uses conservative defaults: distribution 0 (your
 * organisation only), threat_level_id 2 (medium), analysis 0 (initial).
 * Attributes are built from the A_EXTRACT_IOCS shape (urls/domains/ips/hashes)
 * with MISP attribute types, and the TLP marking becomes a lowercased Tag
 * (e.g. "tlp:amber"). When MISP_URL and MISP_API_KEY are set, the event is
 * POSTed and a failed call fails the pipeline.
 */

import type { ActionContext } from "../../../../src/types/action";

interface IocSet {
  urls?: string[];
  domains?: string[];
  ips?: string[];
  hashes?: string[];
}

interface MispAttribute {
  type: string;
  category: string;
  value: string;
  to_ids: boolean;
}

interface MispTag {
  name: string;
}

interface MispEvent {
  info: string;
  distribution: number;
  threat_level_id: number;
  analysis: number;
  Attribute: MispAttribute[];
  Tag: MispTag[];
}

interface MispResult {
  event: MispEvent;
  event_id: string | null;
  source: "stub" | "misp";
}

/** SHA256 (64 hex) → sha256, SHA1 (40) → sha1, MD5 (32) → md5. */
function hashType(hash: string): string {
  if (/^[a-fA-F0-9]{64}$/.test(hash)) return "sha256";
  if (/^[a-fA-F0-9]{40}$/.test(hash)) return "sha1";
  return "md5";
}

function buildAttributes(iocs: IocSet): MispAttribute[] {
  const attrs: MispAttribute[] = [];
  for (const url of iocs.urls ?? []) attrs.push({ type: "url", category: "Network activity", value: url, to_ids: true });
  for (const domain of iocs.domains ?? [])
    attrs.push({ type: "domain", category: "Network activity", value: domain, to_ids: true });
  for (const ip of iocs.ips ?? []) attrs.push({ type: "ip-dst", category: "Network activity", value: ip, to_ids: true });
  for (const hash of iocs.hashes ?? [])
    attrs.push({ type: hashType(hash), category: "Payload delivery", value: hash, to_ids: true });
  return attrs;
}

/** Accept the A_TAG_TLP object shape ({ marking }) or a bare string; render a MISP tag. */
function tlpTag(tlp: unknown): MispTag[] {
  let marking: string | undefined;
  if (typeof tlp === "string") marking = tlp;
  else if (tlp && typeof tlp === "object" && "marking" in tlp) marking = String((tlp as { marking: unknown }).marking);
  if (!marking) return [];
  return [{ name: marking.trim().toLowerCase() }];
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { title, iocs, tlp, ...payload } = input;
    if (typeof title !== "string" || title.length === 0) {
      throw new Error("A_SHARE_MISP: title must be a non-empty string");
    }

    const event: MispEvent = {
      info: title,
      distribution: 0,
      threat_level_id: 2,
      analysis: 0,
      Attribute: buildAttributes((iocs ?? {}) as IocSet),
      Tag: tlpTag(tlp),
    };

    const apiUrl = process.env.MISP_URL;
    const apiKey = process.env.MISP_API_KEY;
    if (!apiUrl || !apiKey) {
      console.log(
        `🛰️  [A_SHARE_MISP] stub mode (MISP_URL/MISP_API_KEY unset) — would push event "${title}" (${event.Attribute.length} attribute(s)) to MISP`,
      );
      const misp: MispResult = { event, event_id: null, source: "stub" };
      return { ...payload, misp };
    }

    const fetchFn = ctx.capabilities.fetch;
    if (!fetchFn) throw new Error("A_SHARE_MISP: fetch capability not injected");

    const endpoint = `${apiUrl.replace(/\/$/, "")}/events`;
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ Event: event }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`A_SHARE_MISP: MISP returned ${res.status} — ${detail}`);
    }
    const created = (await res.json()) as { Event?: { id?: string | number } };
    const eventId = created.Event?.id != null ? String(created.Event.id) : null;

    const misp: MispResult = { event, event_id: eventId, source: "misp" };
    return { ...payload, misp };
  },
};
