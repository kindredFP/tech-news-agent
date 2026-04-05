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
  const topStoriesRes = await fetch(
    "https://hacker-news.firebaseio.com/v0/topstories.json"
  );
  const topStoryIds = await topStoriesRes.json();
  const candidateIds = topStoryIds.slice(0, 20);

  // === STEP 2: Ask the agent to pick the 5 most interesting ===
  const systemPrompt = `You are a tech news curator agent. You have access to a tool called fetch_story_details.
Your job is to:
1. Review the list of Hacker News story IDs provided
2. Use the fetch_story_details tool to retrieve details for exactly 5 stories you think will be most interesting to a tech-savvy audience
3. After fetching all 5, provide a final curated summary of each story

Always fetch exactly 5 stories using the tool before giving your final answer.`;

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
  const apiKey = Netlify.env.get("GEMINI_API_KEY");

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
