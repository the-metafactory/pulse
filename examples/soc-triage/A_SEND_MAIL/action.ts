/**
 * A_SEND_MAIL — mail the advisory to members.
 *
 * Uses the KAI email CLI (~/bin/email), which renders markdown to HTML —
 * the same advisory_doc.markdown that Mattermost posts goes out as a
 * well-formed HTML mail, no second formatter to drift.
 *
 * Recipients via mail_to input or ADVISORY_MAIL_TO env (comma-separated).
 * Unset → skip (mailing members is an explicit decision). Configured →
 * a failed send fails the pipeline, same contract as Mattermost.
 */

import type { ActionContext } from "../../../src/types/action";

interface AdvisoryDoc {
  subject?: string;
  date?: string;
  markdown?: string;
}

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { advisory_doc, mail_to, mail_account, ...payload } = input;
    const doc = (advisory_doc ?? {}) as AdvisoryDoc;

    const to = (mail_to as string | undefined) ?? process.env.ADVISORY_MAIL_TO;
    if (!to) {
      console.log("📭 [A_SEND_MAIL] no recipients (mail_to / ADVISORY_MAIL_TO unset) — skipping");
      return { ...payload, advisory_doc, mail: { sent: false, skipped: true } };
    }

    const { shell, writeFile } = ctx.capabilities;
    if (!shell || !writeFile) throw new Error("A_SEND_MAIL requires 'shell' and 'writeFile' capabilities");

    const subject = doc.subject ?? "CommunitySOC Advisory";
    const bodyFile = `/tmp/soc-advisory-${doc.date ?? "draft"}-${Date.now()}.md`;
    await writeFile(bodyFile, doc.markdown ?? "(no advisory document)");

    const account = (mail_account as string | undefined) ?? process.env.ADVISORY_MAIL_ACCOUNT;
    const accountFlag = account ? ` -a '${account}'` : "";
    const result = await shell(`~/bin/email send -t '${to}' -s '${subject.replace(/'/g, "'\\''")}' -f '${bodyFile}'${accountFlag} && rm -f '${bodyFile}'`);
    if (result.code !== 0) {
      await shell(`rm -f '${bodyFile}'`);
      throw new Error(`A_SEND_MAIL: email send failed: ${(result.stderr || result.stdout).slice(-400)}`);
    }

    console.log(`📧 [A_SEND_MAIL] advisory mailed to ${to}`);
    return { ...payload, advisory_doc, mail: { sent: true, to, subject } };
  },
};
