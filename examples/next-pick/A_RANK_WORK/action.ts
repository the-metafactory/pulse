import type { ActionContext } from "../../../src/types/action";

interface WorkItem {
  type: "issue" | "pr" | "handover" | "blueprint-feature";
  repo: string;
  id: string;
  title: string;
  labels: string[];
  url?: string;
  author?: string;
  status?: string;
  depends?: string[];
  iteration?: number;
  description?: string;
}

interface ScoredItem extends WorkItem {
  score: number;
  scoreBreakdown: string;
}

interface Input {
  workItems: WorkItem[];
  [key: string]: unknown;
}

// Label priority: now=100, next=60, future=20, unlabeled=10
const LABEL_SCORES: Record<string, number> = {
  now: 100,
  next: 60,
  future: 20,
};

// Type priority: handovers=50 (unread = blocking), bugs=40, PRs=30 (blocking collaborators), features=10, blueprint=20
const TYPE_SCORES: Record<string, number> = {
  handover: 50,
  issue: 10,
  pr: 30,
  "blueprint-feature": 20,
};

function scoreLabelPriority(labels: string[]): number {
  let best = 10; // unlabeled default
  for (const label of labels) {
    if (LABEL_SCORES[label] !== undefined && LABEL_SCORES[label] > best) {
      best = LABEL_SCORES[label];
    }
  }
  return best;
}

function scoreType(item: WorkItem): number {
  let base = TYPE_SCORES[item.type] || 0;
  // Bugs get a boost
  if (item.type === "issue" && item.labels.includes("bug")) {
    base += 40;
  }
  return base;
}

function scoreDependency(item: WorkItem, allItems: WorkItem[]): number {
  if (item.type !== "blueprint-feature") return 0;

  // Items that unblock others score higher
  const myId = item.id.split("/").pop() || "";
  const dependents = allItems.filter(
    (other) =>
      other.type === "blueprint-feature" &&
      other.depends?.includes(myId)
  );

  // +15 per dependent feature this unblocks
  let depScore = dependents.length * 15;

  // Lower iteration = higher priority (+10 per iteration advantage)
  if (item.iteration !== undefined) {
    depScore += Math.max(0, (7 - item.iteration)) * 10;
  }

  // In-progress gets a boost over planned (finish what you started)
  if (item.status === "in-progress") {
    depScore += 25;
  }

  // Check if all dependencies are done (not in our work items = done)
  const blockedBy = (item.depends || []).filter((dep) =>
    allItems.some((other) => other.id.endsWith(dep) && other.type === "blueprint-feature")
  );

  if (blockedBy.length > 0) {
    depScore -= 50; // Blocked — can't start this yet
  } else {
    depScore += 15; // Roadmap momentum — unblocked and ready to advance the project
  }

  return depScore;
}

function scoreItems(items: WorkItem[]): ScoredItem[] {
  return items.map((item) => {
    const labelScore = scoreLabelPriority(item.labels);
    const typeScore = scoreType(item);
    const depScore = scoreDependency(item, items);
    const total = labelScore + typeScore + depScore;

    const parts: string[] = [];
    parts.push(`label=${labelScore}`);
    parts.push(`type=${typeScore}`);
    if (depScore !== 0) parts.push(`dep=${depScore}`);

    return {
      ...item,
      score: total,
      scoreBreakdown: parts.join(" + "),
    };
  });
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { workItems, ...upstream } = input;
    const llm = ctx.capabilities.llm;
    if (!llm) throw new Error("LLM capability required");

    // Score all items
    const scored = scoreItems(workItems).sort((a, b) => b.score - a.score);

    // Take top 10 candidates for LLM synthesis
    const candidates = scored.slice(0, 10);

    const candidateList = candidates
      .map((c, i) => {
        const parts = [
          `${i + 1}. [${c.type}] ${c.id}: ${c.title}`,
          `   Score: ${c.score} (${c.scoreBreakdown})`,
          `   Repo: ${c.repo}`,
        ];
        if (c.labels.length) parts.push(`   Labels: ${c.labels.join(", ")}`);
        if (c.url) parts.push(`   URL: ${c.url}`);
        if (c.description) parts.push(`   Description: ${c.description}`);
        if (c.depends?.length) parts.push(`   Depends on: ${c.depends.join(", ")}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const prompt = `You are a development prioritization assistant for the metafactory ecosystem — a marketplace for agentic AI components.

Here are the top ${candidates.length} work items scored by our ranking system (label priority + type urgency + dependency order):

${candidateList}

Scoring rules used:
- Labels: now=100, next=60, future=20, unlabeled=10
- Types: handover=50 (unread handovers block collaboration), bug=50, PR=30 (blocking collaborators), blueprint=20 (roadmap work), issue=10
- Dependencies: +15 per feature this unblocks, +10 per earlier iteration, +25 if in-progress, +15 if unblocked and ready, -50 if blocked by unfinished deps

Select THE SINGLE MOST IMPORTANT item to work on next. Consider:
1. The numeric score (higher = more important by rules)
2. Whether this unblocks other work
3. Whether this is time-sensitive (handovers, blocking PRs)
4. Whether this moves the project forward meaningfully

Return JSON:
{
  "pickId": "the id of the selected item",
  "pickIndex": 0,
  "reasoning": "2-3 sentences explaining WHY this is the top pick — what it unblocks, why it's urgent, what happens if delayed",
  "suggestedFirstStep": "One concrete sentence: what the developer should do first to start this work"
}

Return ONLY valid JSON.`;

    const result = await llm(prompt, {
      tier: "fast",
      system: "You are a precise prioritization engine. Pick one item. Be concrete about why.",
      json: true,
    });

    const parsed = result.json as {
      pickId?: string;
      pickIndex?: number;
      reasoning?: string;
      suggestedFirstStep?: string;
    } | undefined;

    const pickIndex = parsed?.pickIndex ?? 0;
    const topPick = candidates[pickIndex] || candidates[0];

    return {
      ...upstream,
      workItems,
      rankedItems: scored,
      topPick,
      reasoning: parsed?.reasoning || "Selected highest-scored item",
      suggestedFirstStep: parsed?.suggestedFirstStep || "Read the issue or spec to understand scope",
      totalCandidates: workItems.length,
      rankedAt: new Date().toISOString(),
    };
  },
};
