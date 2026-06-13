// ============================================================
// TECH NEWS AGENT - Netlify Serverless Function
// ------------------------------------------------------------
// This is an AI agent, not just a single prompt.
// An agent works in a loop:
//   1. Fetch available data (Hacker News top stories)
//   2. Ask the LLM to decide which ones are worth pursuing
//   3. Execute that decision (fetch story details in a loop)
//   4. Ask the LLM to synthesize the results
// The LLM is "driving" the process - it decides what to fetch.
// ============================================================

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
// ------ TOOLS (what the agent can "do") ----------------------
const tools = [
  {
    name: "fetch_story_details",
    description:
      "Fetches the full details of a Hacker News story by its ID. Use this to get the title, URL, score, and author of a story before summarizing it.",
    parameters: {
      type: "object",
      properties: {
        story_id: {
          type: "number",
          description: "The Hacker News story ID to fetch details for",
        },
      },
      required: ["story_id"],
    },
  },
  {
  name: "fetch_article_content",
  description:
    "Fetches and extracts the readable text content from a URL. Use this after fetch_story_details to read the actual article before summarizing it. Avoid fetching PDFs or GitHub repo URLs.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL of the article to fetch and read",
        },
      },
      required: ["url"],
    },
  },
];

// ------ TOOL EXECUTION ---------------------------------------
async function executeTool(toolName, args) {
  if (toolName === "fetch_story_details") {
    const res = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${args.story_id}.json`
    );
    const story = await res.json();
    return {
      id: story.id,
      title: story.title || "No title",
      url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
      score: story.score || 0,
      author: story.by || "unknown",
      comments: story.descendants || 0,
    };
  }

  if (toolName === "fetch_article_content") {
    const url = args.url;

    if (url.includes("github.com") || url.endsWith(".pdf") || url.includes("youtube.com")) {
      return { content: "Skipped: non-article URL (GitHub/PDF/YouTube). Use the HN title and metadata only." };
    }

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TechNewsBot/1.0)" },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) return { content: `Failed to fetch: HTTP ${res.status}` };

      const html = await res.text();

      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 3000);

      return { content: text || "No readable content extracted." };
    } catch (err) {
      return { content: `Fetch error: ${err.message}` };
    }
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

// ------ CALL GEMINI ------------------------------------------
async function callGemini(apiKey, messages, withTools = false) {
  const body = {
    contents: messages,
    ...(withTools && {
      tools: [{ function_declarations: tools }],
    }),
  };

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${err}`);
  }

  return res.json();
}

// ------ THE AGENT LOOP ---------------------------------------
async function runAgent(apiKey) {
  // === STEP 1: Fetch top story IDs from Hacker News ===
  // Fetch from multiple HN feeds for broader coverage
  const [topRes, bestRes, newRes] = await Promise.all([
    fetch("https://hacker-news.firebaseio.com/v0/topstories.json"),
    fetch("https://hacker-news.firebaseio.com/v0/beststories.json"),
    fetch("https://hacker-news.firebaseio.com/v0/newstories.json"),
  ]);
  const [top, best, newStories] = await Promise.all([
    topRes.json(), bestRes.json(), newRes.json()
  ]);

  // Deduplicate and sample from each feed
  const candidateIds = [...new Set([
    ...top.slice(0, 15),
    ...best.slice(0, 10),
    ...newStories.slice(0, 5)
  ])];

  // === STEP 2: Ask the agent to pick the 5 most interesting ===
  const systemPrompt = `You are a tech news curator agent with access to the fetch_story_details tool.

Your selection criteria — prioritize stories that are:
- Novel technical developments (new tools, breakthroughs, releases)
- High engagement signals (high score or comment count suggests community interest)
- Diverse topics — avoid selecting 2 stories on the same subject
- Relevant to software engineers, developers, or AI practitioners

Your process:
1. Review the candidate story IDs provided
2. Fetch details for your top 8 candidates using fetch_story_details
3. For each story with a real article URL (not just HN discussion links), call fetch_article_content to read it
4. After reviewing the full content, select the 5 best final stories
5. Write a concise summary for each using the actual article content: what it is, why it matters, and one key insight

Always fetch at least 8 stories before making your final selection. Quality of selection matters more than speed.`;

  const userMessage = `Here are the top Hacker News story IDs right now: ${JSON.stringify(candidateIds)}

Please fetch details for the 5 most promising ones and then summarize them for me.`;

  let messages = [
    { role: "user", parts: [{ text: systemPrompt + "\n\n" + userMessage }] },
  ];

  let finalSummary = null;
  const fetchedStories = [];

  // === STEP 3: Agentic loop - keep going until no more tool calls ===
  for (let iteration = 0; iteration < 10; iteration++) {
    const response = await callGemini(apiKey, messages, true);
    const candidate = response.candidates?.[0];
    const content = candidate?.content;

    if (!content) break;

    messages.push({ role: "model", parts: content.parts });

    const toolCalls = content.parts.filter((p) => p.functionCall);

    if (toolCalls.length === 0) {
      const textPart = content.parts.find((p) => p.text);
      if (textPart) {
        finalSummary = textPart.text;
      }
      break;
    }

    const toolResults = [];
    for (const part of toolCalls) {
      const { name, args } = part.functionCall;
      console.log(`Agent calling tool: ${name} with args:`, args);

      const result = await executeTool(name, args);
      fetchedStories.push(result);

      toolResults.push({
        functionResponse: {
          name,
          response: { result },
        },
      });
    }

    messages.push({ role: "user", parts: toolResults });
  }

  return { stories: fetchedStories, summary: finalSummary };
}

// ------ NETLIFY FUNCTION HANDLER -----------------------------
export default async (req) => {

  const apiKey = Netlify.env.get("MY_GEMINI_KEY");
  console.log("API Key found:", apiKey ? `${apiKey.substring(0, 10)}...` : "NOT FOUND");

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await runAgent(apiKey);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Agent error:", err);
    return new Response(
      JSON.stringify({ error: err.message, stack: err.stack }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};

export const config = {
  path: "/api/agent",
};
