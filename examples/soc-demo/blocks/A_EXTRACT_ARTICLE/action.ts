import type { ActionContext } from "../../../../src/types/action";

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

interface Article extends FeedItem {
  content: string;
  wordCount: number;
}

interface Input {
  items: FeedItem[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { items, ...payload } = input;
    const fetchFn = ctx.capabilities.fetch!;

    const fallback = (item: FeedItem): Article => ({
      ...item,
      content: item.description,
      wordCount: item.description.split(/\s+/).length,
    });

    // Independent fetches run concurrently — end-to-end latency is the
    // slowest request, not the sum (sage PR #40 suggestion).
    const articles: Article[] = await Promise.all(
      items.slice(0, 3).map(async (item): Promise<Article> => {
        if (!item.link) return fallback(item);

        try {
          const response = await fetchFn(item.link, {
            headers: { "User-Agent": "pulse/0.1.0" },
            redirect: "follow",
          });

          if (!response.ok) return fallback(item);

          const html = await response.text();

          // Simple content extraction: find <article>, <main>, or largest <p> block
          const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
          const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
          const block = articleMatch?.[1] || mainMatch?.[1] || html;

          // Strip HTML tags, collapse whitespace
          const content = block
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2000);

          return { ...item, content, wordCount: content.split(/\s+/).length };
        } catch (_err) {
          // On fetch error, degrade to the feed description as content.
          return fallback(item);
        }
      }),
    );

    return {
      ...payload,
      articles,
      extractedAt: new Date().toISOString(),
    };
  },
};
