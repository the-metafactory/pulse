import type { ActionContext } from "../../../../src/types/action";

interface Input {
  feedUrl: string;
  limit?: number;
  [key: string]: unknown;
}

/**
 * SSRF guard: feedUrl is pipeline/user-controlled — only http(s) to public
 * hosts may pass. Hostname-literal checks block loopback, RFC-1918 private,
 * link-local (incl. cloud metadata 169.254.169.254), and unique-local IPv6.
 * DNS-rebinding-grade protection is out of scope for a demo ingress block.
 */
function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_err) {
    throw new Error(`A_FETCH_FEED: feedUrl is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`A_FETCH_FEED: feedUrl must be http(s), got ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./, // link-local incl. cloud metadata
    /^::1$/,
    /^f[cd][0-9a-f]{2}:/, // IPv6 unique-local
    /^fe80:/, // IPv6 link-local
  ];
  if (blockedPatterns.some((re) => re.test(host))) {
    throw new Error(`A_FETCH_FEED: feedUrl targets a private/loopback host: ${host}`);
  }
  return url;
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { feedUrl, limit = 5, ...payload } = input;

    assertPublicHttpUrl(feedUrl);

    const fetchFn = ctx.capabilities.fetch!;
    const response = await fetchFn(feedUrl, {
      headers: { "User-Agent": "pulse/0.1.0" },
    });

    if (!response.ok) {
      throw new Error(`Feed fetch failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();

    // Simple XML parsing — extract <item> or <entry> elements
    const items: FeedItem[] = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = match[1] || match[2];
      const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || "";
      const link = block.match(/<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1]?.trim()
        || block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/)?.[1]?.trim() || "";
      const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim()
        || block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/)?.[1]?.trim() || "";
      const pubDate = block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/)?.[1]?.trim()
        || block.match(/<published[^>]*>(.*?)<\/published>/)?.[1]?.trim();

      if (title) {
        items.push({
          title: title.replace(/<[^>]*>/g, ""),
          link,
          description: desc.replace(/<[^>]*>/g, "").slice(0, 500),
          pubDate,
        });
      }
    }

    // Extract feed title
    const feedTitle = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim()?.replace(/<[^>]*>/g, "") || feedUrl;

    return {
      ...payload,
      feedUrl,
      feedTitle,
      items,
      fetchedAt: new Date().toISOString(),
    };
  },
};
