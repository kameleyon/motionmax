/**
 * Server-side attachment processing.
 *
 * Extracts content from URLs tagged in the generation content:
 *   [FETCH_URL] https://example.com       → fetches page, strips HTML, extracts text
 *   [YOUTUBE_URL] https://youtube.com/...  → fetches oEmbed metadata + attempts transcript
 *   [GITHUB_URL] https://github.com/...   → fetches README.md
 *   [SOURCE IMAGE] https://...            → passes through (Gemini handles multimodal)
 *   [SOURCE TEXT: ...] / [SOURCE FILE: ...]→ already has content, passes through
 *
 * Called before research phase to enrich content with actual source data.
 */

const FETCH_TIMEOUT = 10_000; // 10s per URL fetch

/**
 * Process tagged attachments in the content string.
 * Replaces [FETCH_URL], [YOUTUBE_URL], [GITHUB_URL] tags with fetched content.
 */
export async function processContentAttachments(content: string): Promise<string> {
  if (!content.includes("--- ATTACHED SOURCES ---")) return content;

  const lines = content.split("\n");
  const processed: string[] = [];

  for (const line of lines) {
    if (line.startsWith("[FETCH_URL] ")) {
      const url = line.replace("[FETCH_URL] ", "").trim();
      const text = await fetchWebPage(url);
      processed.push(text ? `[SOURCE FROM ${url}]\n${text}` : line);
    } else if (line.startsWith("[YOUTUBE_URL] ")) {
      const url = line.replace("[YOUTUBE_URL] ", "").trim();
      const info = await fetchYouTubeInfo(url);
      processed.push(info ? `[YOUTUBE SOURCE]\n${info}` : line);
    } else if (line.startsWith("[GITHUB_URL] ")) {
      const url = line.replace("[GITHUB_URL] ", "").trim();
      const readme = await fetchGitHubReadme(url);
      processed.push(readme ? `[GITHUB SOURCE]\n${readme}` : line);
    } else {
      processed.push(line);
    }
  }

  return processed.join("\n");
}

/**
 * Fetch a web page and extract readable text content.
 */
async function fetchWebPage(url: string): Promise<string | null> {
  try {
    console.log(`[Attachments] Fetching web page: ${url}`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MotionMaxBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,text/plain",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      console.warn(`[Attachments] Failed to fetch ${url}: ${res.status}`);
      return null;
    }

    const html = await res.text();
    // Strip HTML tags, scripts, styles to get readable text
    const text = stripHtml(html);
    const trimmed = text.substring(0, 15_000); // Cap at 15K chars
    console.log(`[Attachments] Extracted ${trimmed.length} chars from ${url}`);
    return trimmed;
  } catch (err) {
    console.warn(`[Attachments] Fetch error for ${url}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch YouTube video metadata via oEmbed.
 */
async function fetchYouTubeInfo(url: string): Promise<string | null> {
  try {
    console.log(`[Attachments] Fetching YouTube info: ${url}`);

    // Extract video ID
    const videoId = extractYouTubeId(url);
    if (!videoId) return `YouTube video: ${url}`;

    // oEmbed for title + author
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });

    let title = "Unknown";
    let author = "Unknown";
    if (res.ok) {
      const data = await res.json() as any;
      title = data.title || "Unknown";
      author = data.author_name || "Unknown";
    }

    // Try to get auto-generated transcript via YouTube's timedtext API
    let transcript = "";
    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MotionMaxBot/1.0)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (pageRes.ok) {
        const pageHtml = await pageRes.text();
        // Extract caption track URL from page source
        const captionMatch = pageHtml.match(/"captionTracks":\[.*?"baseUrl":"(.*?)"/);
        if (captionMatch) {
          const captionUrl = captionMatch[1].replace(/\\u0026/g, "&");
          const captionRes = await fetch(captionUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
          if (captionRes.ok) {
            const captionXml = await captionRes.text();
            // Extract text from XML caption track
            transcript = captionXml
              .replace(/<[^>]+>/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&#39;/g, "'")
              .replace(/&quot;/g, '"')
              .replace(/\s+/g, " ")
              .trim()
              .substring(0, 10_000);
          }
        }
      }
    } catch {
      // Transcript extraction is best-effort
    }

    const result = `Title: ${title}\nChannel: ${author}\nURL: ${url}${transcript ? `\nTranscript:\n${transcript}` : ""}`;
    console.log(`[Attachments] YouTube: "${title}" by ${author} (${transcript.length} chars transcript)`);
    return result;
  } catch (err) {
    console.warn(`[Attachments] YouTube fetch error: ${(err as Error).message}`);
    return `YouTube video: ${url}`;
  }
}

function extractYouTubeId(url: string): string | null {
  const match = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Fetch GitHub repository README.
 */
async function fetchGitHubReadme(url: string): Promise<string | null> {
  try {
    console.log(`[Attachments] Fetching GitHub README: ${url}`);

    // Extract owner/repo from URL
    const match = url.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
    if (!match) return `GitHub repository: ${url}`;

    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;

    const res = await fetch(apiUrl, {
      headers: {
        "Accept": "application/vnd.github.v3.raw",
        "User-Agent": "MotionMaxBot/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      console.warn(`[Attachments] GitHub API ${res.status} for ${owner}/${repo}`);
      return `GitHub repository: ${url}`;
    }

    const readme = await res.text();
    const trimmed = readme.substring(0, 15_000);
    console.log(`[Attachments] GitHub README: ${trimmed.length} chars from ${owner}/${repo}`);
    return `Repository: ${owner}/${repo}\nURL: ${url}\n\n${trimmed}`;
  } catch (err) {
    console.warn(`[Attachments] GitHub fetch error: ${(err as Error).message}`);
    return `GitHub repository: ${url}`;
  }
}

/**
 * Strip HTML tags and extract readable text.
 */
function stripHtml(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<br[^>]*\/?>/gi, "\n")
    // Remove remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    // Normalize whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
