/**
 * A_INGEST_ATTACHMENT — inline content (Mattermost) + EML MIME parsing.
 *
 * The live failure (2026-06-16): a Mattermost .eml upload never reached the
 * flow (MM file URLs need auth + weren't host-allowlisted), so A_EXTRACT_IOCS
 * saw nothing and the guard halted. The adapter now inlines the bytes; this
 * block decodes them (no fetch) and, for an .eml, decodes the MIME parts so
 * body URLs (base64/quoted-printable) survive for extraction.
 */

import { describe, expect, test } from "bun:test";
import { ctxWith } from "./helpers/soc-demo-test-helpers";

const mod = () => import("../examples/soc-demo/blocks/A_INGEST_ATTACHMENT/action");

function emlWith(bodyEncoding: "base64" | "quoted-printable", url: string): string {
  const plain = `Dear member, confirm your reservation at ${url} today.`;
  const body = bodyEncoding === "base64"
    ? Buffer.from(plain).toString("base64")
    : plain.replace(/\./g, "=2E"); // crude QP: encode dots
  const eml = [
    "From: attacker@phish-domain.test",
    "To: victim@corp.test",
    "Subject: GROUP RESERVATION REQUIREMENTS",
    "Content-Type: multipart/mixed; boundary=BND",
    "",
    "--BND",
    "Content-Type: text/plain",
    `Content-Transfer-Encoding: ${bodyEncoding}`,
    "",
    body,
    "--BND--",
    "",
  ].join("\n");
  return Buffer.from(eml).toString("base64");
}

describe("A_INGEST_ATTACHMENT — inline content + EML", () => {
  test("inline base64 EML decodes WITHOUT a fetch capability (Mattermost path)", async () => {
    const m = await mod();
    const content = emlWith("base64", "https://evil-phish.example/login");
    // ctxWith() → no fetch; inline content must still ingest.
    const r = (await m.default.execute(
      { text: "", attachments: [{ name: "phish.eml", contentType: "message/rfc822", content }] },
      ctxWith(),
    )) as Record<string, unknown>;
    expect(r.text).toContain("https://evil-phish.example/login"); // body URL decoded
    expect(r.text).toContain("phish-domain.test"); // sender header in the clear
    expect((r.attachments_ingested as { decoded: number }).decoded).toBe(1);
  });

  test("quoted-printable EML body is decoded too", async () => {
    const m = await mod();
    const content = emlWith("quoted-printable", "https://qp-phish.example/pay");
    const r = (await m.default.execute(
      { text: "", attachments: [{ name: "p.eml", contentType: "message/rfc822", content }] },
      ctxWith(),
    )) as Record<string, unknown>;
    expect(r.text).toContain("https://qp-phish.example/pay");
  });

  test("attachments pass through unchanged (monotonic payload)", async () => {
    const m = await mod();
    const content = emlWith("base64", "https://x.example/y");
    const r = (await m.default.execute(
      { text: "", attachments: [{ name: "p.eml", contentType: "message/rfc822", content }] },
      ctxWith(),
    )) as Record<string, unknown>;
    expect(Array.isArray(r.attachments)).toBe(true);
  });

  test("no attachments → clean passthrough", async () => {
    const m = await mod();
    const r = (await m.default.execute({ text: "hi" }, ctxWith())) as Record<string, unknown>;
    expect(r.text).toBe("hi");
    expect((r.attachments_ingested as { decoded: number }).decoded).toBe(0);
  });
});
