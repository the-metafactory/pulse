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

import type { ActionContext } from "../../../../src/types/action";

interface AdvisoryDoc {
  subject?: string;
  date?: string;
  markdown?: string;
}

/** POSIX single-quote escape: close, insert an escaped quote, reopen. Safe for any value inside '…'. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** One or more comma-separated email addresses, nothing exotic. Rejects shell metacharacters by construction. */
const RECIPIENTS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\s*,\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})*$/;
/** Account names are simple identifiers — never interpolate anything else into the command. */
const ACCOUNT_RE = /^[A-Za-z0-9._-]+$/;

export default {
  async execute(input: Record<string, unknown>, ctx: ActionContext) {
    const { advisory_doc, mail_to, mail_account, ...payload } = input;
    const doc = (advisory_doc ?? {}) as AdvisoryDoc;

    const to = (mail_to as string | undefined) ?? process.env.ADVISORY_MAIL_TO;
    if (!to) {
      console.log("📭 [A_SEND_MAIL] no recipients (mail_to / ADVISORY_MAIL_TO unset) — skipping");
      return { ...payload, advisory_doc, mail: { sent: false, skipped: true } };
    }
    // Validate the recipient list before it ever reaches a shell — defense in
    // depth even when the enforcement gate is active. A value carrying shell
    // metacharacters is refused here, not escaped-and-hoped.
    if (!RECIPIENTS_RE.test(to.trim())) {
      throw new Error(`A_SEND_MAIL: refusing to send — '${to}' is not a valid comma-separated email recipient list`);
    }

    const account = (mail_account as string | undefined) ?? process.env.ADVISORY_MAIL_ACCOUNT;
    if (account !== undefined && !ACCOUNT_RE.test(account)) {
      throw new Error(`A_SEND_MAIL: refusing to send — mail account '${account}' contains illegal characters`);
    }

    const { shell, writeFile } = ctx.capabilities;
    if (!shell || !writeFile) throw new Error("A_SEND_MAIL requires 'shell' and 'writeFile' capabilities");

    const subject = doc.subject ?? "CommunitySOC Advisory";
    // doc.date is model-influenced — keep it out of the path entirely; a UUID is enough.
    const bodyFile = `/tmp/soc-advisory-${crypto.randomUUID()}.md`;
    await writeFile(bodyFile, doc.markdown ?? "(no advisory document)");

    // Every interpolated value is shell-quoted; `to` and `account` are also
    // pattern-validated above, so the quoting is the second line of defense.
    const accountFlag = account ? ` -a ${shellQuote(account)}` : "";
    const cmd =
      `~/bin/email send -t ${shellQuote(to.trim())} -s ${shellQuote(subject)} -f ${shellQuote(bodyFile)}${accountFlag}` +
      ` && rm -f ${shellQuote(bodyFile)}`;
    const result = await shell(cmd);
    if (result.code !== 0) {
      await shell(`rm -f ${shellQuote(bodyFile)}`);
      throw new Error(`A_SEND_MAIL: email send failed: ${(result.stderr || result.stdout).slice(-400)}`);
    }

    console.log(`📧 [A_SEND_MAIL] advisory mailed to ${to}`);
    return { ...payload, advisory_doc, mail: { sent: true, to, subject } };
  },
};
