/**
 * A_WRITE_BUILDLOG — publish the journal entry to the public build log.
 *
 * Writes build-log/{date}-build-journal.html into the myelin-cortex-site
 * repo (stack.meta-factory.ai) and regenerates build-log/index.html from the
 * entries.json manifest. Styling reuses the site's single stylesheet —
 * same article.prose markup as the blog. Deploy stays a human step
 * (wrangler), so a bad entry never auto-ships.
 */

import type { ActionContext } from "../../../src/types/action";

interface JournalEntry {
  date: string;
  slug: string;
  headline: string;
  narrative: string;
  highlights: string[];
  perspective: string;
  additions: string[];
  sign_off: boolean;
  stats: { period_days: number; total_commits: number; active_repos: string[] };
  provenance: Record<string, string>;
}

interface ManifestEntry {
  date: string;
  slug: string;
  headline: string;
  excerpt: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Truncate at a word boundary with an ellipsis — no mid-word cuts in meta descriptions or excerpts. */
function excerptOf(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

function pageShell(title: string, description: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — myelin + cortex</title>
  <meta name="description" content="${esc(description)}">
  <link rel="stylesheet" href="/assets/style.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="/">
        <div class="brand-mark">M+C</div>
        <div class="brand-name">
          <span class="kicker">Nervous-system stack · №01</span>
          <span class="title">myelin + cortex</span>
        </div>
      </a>
      <nav class="site-nav">
        <a href="/build-log/">build log</a>
        <a href="/blog/">blog</a>
        <a href="/docs/">docs</a>
      </nav>
    </div>
  </header>

  <main>
${body}
  </main>

  <footer class="site-footer">
    <div class="wrap">
      <p>Written by the fleet, gated by humans. · <a href="/build-log/">build log index</a> · <a href="/">stack.meta-factory.ai</a></p>
    </div>
  </footer>
</body>
</html>
`;
}

function entryPage(e: JournalEntry): string {
  const highlights = e.highlights.map((h) => `        <li>${esc(h)}</li>`).join("\n");
  const additions = e.additions.map((a) => `        <li>${esc(a)}</li>`).join("\n");
  const body = `    <article class="prose narrow">
      <p class="meta">${e.date} · build journal · ${e.stats.total_commits} commits / ${e.stats.active_repos.length} repos / ${e.stats.period_days} days</p>
      <h1>${esc(e.headline)}</h1>
      <p>${esc(e.narrative)}</p>
${e.highlights.length ? `      <h2>Shipped</h2>\n      <ul>\n${highlights}\n      </ul>` : ""}
      <h2>From the meta-factory stack</h2>
      <p class="meta">Andreas' agent — answered over <code>federated.andreas.meta-factory</code></p>
      <p>${esc(e.perspective)}</p>
${e.additions.length ? `      <ul>\n${additions}\n      </ul>` : ""}
      <h2>Provenance</h2>
      <ul>
        <li>Draft: ${esc(e.provenance.draft_by ?? "?")}</li>
        <li>Perspective: ${esc(e.provenance.perspective_by ?? "?")}</li>
        <li>Approved: human gate <code>${esc(e.provenance.approved_by_gate ?? "?")}</code> at ${esc(e.provenance.approved_at ?? "?")}</li>
        <li>Assembled: ${esc(e.provenance.pipeline ?? "pulse")}</li>
      </ul>
      <p class="meta">Active repos: ${e.stats.active_repos.map(esc).join(", ")}</p>
    </article>`;
  return pageShell(e.headline, excerptOf(e.narrative, 150), body);
}

function indexPage(entries: ManifestEntry[]): string {
  const items = entries
    .map(
      (e) => `        <li>
          <span class="date">${e.date} · build journal</span>
          <h3><a href="/build-log/${e.slug}.html">${esc(e.headline)}</a></h3>
          <p class="excerpt">${esc(e.excerpt)}</p>
        </li>`,
    )
    .join("\n");
  const body = `    <article class="prose narrow">
      <p class="meta">Build log · The ecosystem, building itself, in public</p>
      <h1>Build log</h1>
      <p style="color:var(--muted);">
        A recurring journal written by the agent fleet: Jens-Christian's agent drafts from
        raw repo activity, Andreas' agent answers across the federation boundary, a human
        gates it, and a pulse pipeline publishes it here. Newest first.
      </p>
      <ul class="post-list">
${items}
      </ul>
    </article>`;
  return pageShell("Build log", "The metafactory ecosystem build journal — written by the agent fleet, gated by humans.", body);
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { entry, site_dir, ...payload } = input;
    const e = entry as JournalEntry;
    const { readFile, writeFile, shell } = ctx.capabilities;
    if (!readFile || !writeFile || !shell) {
      throw new Error("A_WRITE_BUILDLOG requires 'readFile', 'writeFile', and 'shell' capabilities");
    }

    const siteDir = (site_dir as string | undefined) ?? `${process.env.HOME}/work/mf/myelin-cortex-site`;
    const check = await shell(`test -d '${siteDir}' && echo yes || echo no`);
    if (check.stdout.trim() !== "yes") {
      throw new Error(`A_WRITE_BUILDLOG: site directory not found: ${siteDir}`);
    }
    const dir = `${siteDir}/build-log`;
    await shell(`mkdir -p '${dir}'`);

    // Manifest: append-or-replace this entry, newest first
    let manifest: ManifestEntry[] = [];
    try {
      manifest = JSON.parse(await readFile(`${dir}/entries.json`)) as ManifestEntry[];
    } catch (_err) {
      // first entry — manifest does not exist yet
    }
    const record: ManifestEntry = {
      date: e.date,
      slug: e.slug,
      headline: e.headline,
      excerpt: excerptOf(e.narrative, 220),
    };
    manifest = [record, ...manifest.filter((m) => m.slug !== e.slug)].sort((a, b) => b.date.localeCompare(a.date));

    await writeFile(`${dir}/${e.slug}.html`, entryPage(e));
    await writeFile(`${dir}/entries.json`, JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(`${dir}/index.html`, indexPage(manifest));

    console.log(`🌐 [A_WRITE_BUILDLOG] wrote build-log/${e.slug}.html + index (${manifest.length} entries) in ${siteDir}`);
    return {
      ...payload,
      entry,
      buildlog: { page: `build-log/${e.slug}.html`, entries: manifest.length, site_dir: siteDir },
    };
  },
};
