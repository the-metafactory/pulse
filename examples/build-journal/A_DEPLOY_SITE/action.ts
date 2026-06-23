/**
 * A_DEPLOY_SITE — ship the build log to stack.meta-factory.ai.
 *
 * Three steps, each surfaced honestly:
 *   1. commit  — stage build-log/ in the site repo; skip the commit when
 *                nothing changed (re-deploys of already-committed content)
 *   2. push    — keep GitHub the source of truth (deploys never outrun main).
 *                Fast-forwards because A_WRITE_BUILDLOG already synced the site
 *                repo to origin/main before writing the entry; an unattended run
 *                on a drifted checkout would otherwise fail non-fast-forward.
 *   3. deploy  — `bun run deploy` (wrangler pages deploy → Cloudflare Pages)
 *
 * Opt-in via site_deploy (--deploy on the runner): publishing is an explicit
 * decision, never a side effect of running the pipeline. Requires a
 * wrangler-authenticated environment (bunx wrangler login).
 */

import type { ActionContext } from "../../../src/types/action";

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { site_deploy, site_dir, ...payload } = input;

    if (!site_deploy) {
      console.log("🚢 [A_DEPLOY_SITE] site_deploy not set — skipping (pass --deploy to ship)");
      return { ...payload, deploy: { deployed: false, skipped: true } };
    }

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("A_DEPLOY_SITE requires the 'shell' capability");

    const siteDir = (site_dir as string | undefined) ?? `${process.env.HOME}/work/mf/myelin-cortex-site`;
    const git = (cmd: string) => shell(`git -C '${siteDir}' ${cmd}`);

    const check = await shell(`test -d '${siteDir}/.git' && echo yes || echo no`);
    if (check.stdout.trim() !== "yes") {
      throw new Error(`A_DEPLOY_SITE: site repo not found: ${siteDir}`);
    }

    // 1. Commit new build-log content (no-op when the tree is clean).
    const status = await git(`status --porcelain build-log`);
    let committed = false;
    if (status.stdout.trim().length > 0) {
      const date = new Date().toISOString().slice(0, 10);
      await git(`add build-log`);
      const commit = await git(`commit -m "content: build journal ${date}" -m "Published by pulse P_BUILD_JOURNAL."`);
      if (commit.code !== 0) {
        throw new Error(`A_DEPLOY_SITE: commit failed: ${(commit.stderr || commit.stdout).slice(0, 300)}`);
      }
      committed = true;
      console.log(`🚢 [A_DEPLOY_SITE] committed build-log changes (${status.stdout.trim().split("\n").length} file(s))`);
    } else {
      console.log("🚢 [A_DEPLOY_SITE] build-log unchanged in site repo — nothing to commit");
    }

    // 2. Push — GitHub stays the source of truth for what is live.
    if (committed) {
      const push = await git(`push`);
      if (push.code !== 0) {
        throw new Error(`A_DEPLOY_SITE: push failed: ${(push.stderr || push.stdout).slice(0, 300)}`);
      }
      console.log("🚢 [A_DEPLOY_SITE] pushed to origin");
    }

    // 3. Deploy via wrangler (Cloudflare Pages).
    const deploy = await shell(`cd '${siteDir}' && bun run deploy 2>&1`);
    if (deploy.code !== 0) {
      throw new Error(`A_DEPLOY_SITE: wrangler deploy failed: ${(deploy.stderr || deploy.stdout).slice(-400)}`);
    }
    const urlMatch = deploy.stdout.match(/https:\/\/\S+\.pages\.dev\S*/);
    console.log(`🚢 [A_DEPLOY_SITE] deployed — https://stack.meta-factory.ai/build-log/${urlMatch ? ` (${urlMatch[0]})` : ""}`);

    return {
      ...payload,
      deploy: {
        deployed: true,
        committed,
        site_dir: siteDir,
        url: "https://stack.meta-factory.ai/build-log/",
        pages_url: urlMatch?.[0] ?? null,
      },
    };
  },
};
