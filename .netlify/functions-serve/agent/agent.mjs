
import {createRequire as ___nfyCreateRequire} from "module";
import {fileURLToPath as ___nfyFileURLToPath} from "url";
import {dirname as ___nfyPathDirname} from "path";
let __filename=___nfyFileURLToPath(import.meta.url);
let __dirname=___nfyPathDirname(___nfyFileURLToPath(import.meta.url));
let require=___nfyCreateRequire(import.meta.url);


// netlify/functions/agent.mjs
var GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
var tools = [
  {
    name: "fetch_story_details",
    description: "Fetches the full details of a Hacker News story by its ID. Use this to get the title, URL, score, and author of a story before summarizing it.",
    parameters: {
      type: "object",
      properties: {
        story_id: {
          type: "number",
          description: "The Hacker News story ID to fetch details for"
        }
      },
      required: ["story_id"]
    }
  },
  {
    name: "fetch_article_content",
    description: "Fetches and extracts the readable text content from a URL. Use this after fetch_story_details to read the actual article before summarizing it. Avoid fetching PDFs or GitHub repo URLs.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL of the article to fetch and read"
        }
      },
      required: ["url"]
    }
  }
];
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
      comments: story.descendants || 0
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
        signal: AbortSignal.timeout(8e3)
      });
      if (!res.ok) return { content: `Failed to fetch: HTTP ${res.status}` };
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim().slice(0, 3e3);
      return { content: text || "No readable content extracted." };
    } catch (err) {
      return { content: `Fetch error: ${err.message}` };
    }
  }
  throw new Error(`Unknown tool: ${toolName}`);
}
async function callGemini(apiKey, messages, withTools = false) {
  const body = {
    contents: messages,
    ...withTools && {
      tools: [{ function_declarations: tools }]
    }
  };
  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${err}`);
  }
  return res.json();
}
async function runAgent(apiKey) {
  const [topRes, bestRes, newRes] = await Promise.all([
    fetch("https://hacker-news.firebaseio.com/v0/topstories.json"),
    fetch("https://hacker-news.firebaseio.com/v0/beststories.json"),
    fetch("https://hacker-news.firebaseio.com/v0/newstories.json")
  ]);
  const [top, best, newStories] = await Promise.all([
    topRes.json(),
    bestRes.json(),
    newRes.json()
  ]);
  const candidateIds = [.../* @__PURE__ */ new Set([
    ...top.slice(0, 15),
    ...best.slice(0, 10),
    ...newStories.slice(0, 5)
  ])];
  const systemPrompt = `You are a tech news curator agent with access to the fetch_story_details tool.

Your selection criteria \u2014 prioritize stories that are:
- Novel technical developments (new tools, breakthroughs, releases)
- High engagement signals (high score or comment count suggests community interest)
- Diverse topics \u2014 avoid selecting 2 stories on the same subject
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
    { role: "user", parts: [{ text: systemPrompt + "\n\n" + userMessage }] }
  ];
  let finalSummary = null;
  const fetchedStories = [];
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
          response: { result }
        }
      });
    }
    messages.push({ role: "user", parts: toolResults });
  }
  return { stories: fetchedStories, summary: finalSummary };
}
var agent_default = async (req) => {
  const apiKey = Netlify.env.get("MY_GEMINI_KEY");
  console.log("API Key found:", apiKey ? `${apiKey.substring(0, 10)}...` : "NOT FOUND");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const result = await runAgent(apiKey);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Agent error:", err);
    return new Response(
      JSON.stringify({ error: err.message, stack: err.stack }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};
var config = {
  path: "/api/agent"
};
export {
  config,
  agent_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibmV0bGlmeS9mdW5jdGlvbnMvYWdlbnQubWpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRFQ0ggTkVXUyBBR0VOVCAtIE5ldGxpZnkgU2VydmVybGVzcyBGdW5jdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGlzIGlzIGFuIEFJIGFnZW50LCBub3QganVzdCBhIHNpbmdsZSBwcm9tcHQuXG4vLyBBbiBhZ2VudCB3b3JrcyBpbiBhIGxvb3A6XG4vLyAgIDEuIEZldGNoIGF2YWlsYWJsZSBkYXRhIChIYWNrZXIgTmV3cyB0b3Agc3Rvcmllcylcbi8vICAgMi4gQXNrIHRoZSBMTE0gdG8gZGVjaWRlIHdoaWNoIG9uZXMgYXJlIHdvcnRoIHB1cnN1aW5nXG4vLyAgIDMuIEV4ZWN1dGUgdGhhdCBkZWNpc2lvbiAoZmV0Y2ggc3RvcnkgZGV0YWlscyBpbiBhIGxvb3ApXG4vLyAgIDQuIEFzayB0aGUgTExNIHRvIHN5bnRoZXNpemUgdGhlIHJlc3VsdHNcbi8vIFRoZSBMTE0gaXMgXCJkcml2aW5nXCIgdGhlIHByb2Nlc3MgLSBpdCBkZWNpZGVzIHdoYXQgdG8gZmV0Y2guXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgR0VNSU5JX0FQSV9VUkwgPVxuICBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YS9tb2RlbHMvZ2VtaW5pLTIuNS1mbGFzaDpnZW5lcmF0ZUNvbnRlbnRcIjtcbi8vIC0tLS0tLSBUT09MUyAod2hhdCB0aGUgYWdlbnQgY2FuIFwiZG9cIikgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuY29uc3QgdG9vbHMgPSBbXG4gIHtcbiAgICBuYW1lOiBcImZldGNoX3N0b3J5X2RldGFpbHNcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiRmV0Y2hlcyB0aGUgZnVsbCBkZXRhaWxzIG9mIGEgSGFja2VyIE5ld3Mgc3RvcnkgYnkgaXRzIElELiBVc2UgdGhpcyB0byBnZXQgdGhlIHRpdGxlLCBVUkwsIHNjb3JlLCBhbmQgYXV0aG9yIG9mIGEgc3RvcnkgYmVmb3JlIHN1bW1hcml6aW5nIGl0LlwiLFxuICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgIHR5cGU6IFwib2JqZWN0XCIsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHN0b3J5X2lkOiB7XG4gICAgICAgICAgdHlwZTogXCJudW1iZXJcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJUaGUgSGFja2VyIE5ld3Mgc3RvcnkgSUQgdG8gZmV0Y2ggZGV0YWlscyBmb3JcIixcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogW1wic3RvcnlfaWRcIl0sXG4gICAgfSxcbiAgfSxcbiAge1xuICBuYW1lOiBcImZldGNoX2FydGljbGVfY29udGVudFwiLFxuICBkZXNjcmlwdGlvbjpcbiAgICBcIkZldGNoZXMgYW5kIGV4dHJhY3RzIHRoZSByZWFkYWJsZSB0ZXh0IGNvbnRlbnQgZnJvbSBhIFVSTC4gVXNlIHRoaXMgYWZ0ZXIgZmV0Y2hfc3RvcnlfZGV0YWlscyB0byByZWFkIHRoZSBhY3R1YWwgYXJ0aWNsZSBiZWZvcmUgc3VtbWFyaXppbmcgaXQuIEF2b2lkIGZldGNoaW5nIFBERnMgb3IgR2l0SHViIHJlcG8gVVJMcy5cIixcbiAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICB0eXBlOiBcIm9iamVjdFwiLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICB1cmw6IHtcbiAgICAgICAgICB0eXBlOiBcInN0cmluZ1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlRoZSBmdWxsIFVSTCBvZiB0aGUgYXJ0aWNsZSB0byBmZXRjaCBhbmQgcmVhZFwiLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbXCJ1cmxcIl0sXG4gICAgfSxcbiAgfSxcbl07XG5cbi8vIC0tLS0tLSBUT09MIEVYRUNVVElPTiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUb29sKHRvb2xOYW1lLCBhcmdzKSB7XG4gIGlmICh0b29sTmFtZSA9PT0gXCJmZXRjaF9zdG9yeV9kZXRhaWxzXCIpIHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChcbiAgICAgIGBodHRwczovL2hhY2tlci1uZXdzLmZpcmViYXNlaW8uY29tL3YwL2l0ZW0vJHthcmdzLnN0b3J5X2lkfS5qc29uYFxuICAgICk7XG4gICAgY29uc3Qgc3RvcnkgPSBhd2FpdCByZXMuanNvbigpO1xuICAgIHJldHVybiB7XG4gICAgICBpZDogc3RvcnkuaWQsXG4gICAgICB0aXRsZTogc3RvcnkudGl0bGUgfHwgXCJObyB0aXRsZVwiLFxuICAgICAgdXJsOiBzdG9yeS51cmwgfHwgYGh0dHBzOi8vbmV3cy55Y29tYmluYXRvci5jb20vaXRlbT9pZD0ke3N0b3J5LmlkfWAsXG4gICAgICBzY29yZTogc3Rvcnkuc2NvcmUgfHwgMCxcbiAgICAgIGF1dGhvcjogc3RvcnkuYnkgfHwgXCJ1bmtub3duXCIsXG4gICAgICBjb21tZW50czogc3RvcnkuZGVzY2VuZGFudHMgfHwgMCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHRvb2xOYW1lID09PSBcImZldGNoX2FydGljbGVfY29udGVudFwiKSB7XG4gICAgY29uc3QgdXJsID0gYXJncy51cmw7XG5cbiAgICBpZiAodXJsLmluY2x1ZGVzKFwiZ2l0aHViLmNvbVwiKSB8fCB1cmwuZW5kc1dpdGgoXCIucGRmXCIpIHx8IHVybC5pbmNsdWRlcyhcInlvdXR1YmUuY29tXCIpKSB7XG4gICAgICByZXR1cm4geyBjb250ZW50OiBcIlNraXBwZWQ6IG5vbi1hcnRpY2xlIFVSTCAoR2l0SHViL1BERi9Zb3VUdWJlKS4gVXNlIHRoZSBITiB0aXRsZSBhbmQgbWV0YWRhdGEgb25seS5cIiB9O1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcbiAgICAgICAgaGVhZGVyczogeyBcIlVzZXItQWdlbnRcIjogXCJNb3ppbGxhLzUuMCAoY29tcGF0aWJsZTsgVGVjaE5ld3NCb3QvMS4wKVwiIH0sXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg4MDAwKSxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIXJlcy5vaykgcmV0dXJuIHsgY29udGVudDogYEZhaWxlZCB0byBmZXRjaDogSFRUUCAke3Jlcy5zdGF0dXN9YCB9O1xuXG4gICAgICBjb25zdCBodG1sID0gYXdhaXQgcmVzLnRleHQoKTtcblxuICAgICAgY29uc3QgdGV4dCA9IGh0bWxcbiAgICAgICAgLnJlcGxhY2UoLzxzY3JpcHRbXFxzXFxTXSo/PFxcL3NjcmlwdD4vZ2ksIFwiXCIpXG4gICAgICAgIC5yZXBsYWNlKC88c3R5bGVbXFxzXFxTXSo/PFxcL3N0eWxlPi9naSwgXCJcIilcbiAgICAgICAgLnJlcGxhY2UoLzxbXj5dKz4vZywgXCIgXCIpXG4gICAgICAgIC5yZXBsYWNlKC8mbmJzcDsvZywgXCIgXCIpXG4gICAgICAgIC5yZXBsYWNlKC8mYW1wOy9nLCBcIiZcIilcbiAgICAgICAgLnJlcGxhY2UoLyZsdDsvZywgXCI8XCIpXG4gICAgICAgIC5yZXBsYWNlKC8mZ3Q7L2csIFwiPlwiKVxuICAgICAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAgICAgLnRyaW0oKVxuICAgICAgICAuc2xpY2UoMCwgMzAwMCk7XG5cbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IHRleHQgfHwgXCJObyByZWFkYWJsZSBjb250ZW50IGV4dHJhY3RlZC5cIiB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHsgY29udGVudDogYEZldGNoIGVycm9yOiAke2Vyci5tZXNzYWdlfWAgfTtcbiAgICB9XG4gIH1cblxuICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gdG9vbDogJHt0b29sTmFtZX1gKTtcbn1cblxuLy8gLS0tLS0tIENBTEwgR0VNSU5JIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gY2FsbEdlbWluaShhcGlLZXksIG1lc3NhZ2VzLCB3aXRoVG9vbHMgPSBmYWxzZSkge1xuICBjb25zdCBib2R5ID0ge1xuICAgIGNvbnRlbnRzOiBtZXNzYWdlcyxcbiAgICAuLi4od2l0aFRvb2xzICYmIHtcbiAgICAgIHRvb2xzOiBbeyBmdW5jdGlvbl9kZWNsYXJhdGlvbnM6IHRvb2xzIH1dLFxuICAgIH0pLFxuICB9O1xuXG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke0dFTUlOSV9BUElfVVJMfT9rZXk9JHthcGlLZXl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICB9KTtcblxuICBpZiAoIXJlcy5vaykge1xuICAgIGNvbnN0IGVyciA9IGF3YWl0IHJlcy50ZXh0KCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBHZW1pbmkgQVBJIGVycm9yOiAke2Vycn1gKTtcbiAgfVxuXG4gIHJldHVybiByZXMuanNvbigpO1xufVxuXG4vLyAtLS0tLS0gVEhFIEFHRU5UIExPT1AgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBydW5BZ2VudChhcGlLZXkpIHtcbiAgLy8gPT09IFNURVAgMTogRmV0Y2ggdG9wIHN0b3J5IElEcyBmcm9tIEhhY2tlciBOZXdzID09PVxuICAvLyBGZXRjaCBmcm9tIG11bHRpcGxlIEhOIGZlZWRzIGZvciBicm9hZGVyIGNvdmVyYWdlXG4gIGNvbnN0IFt0b3BSZXMsIGJlc3RSZXMsIG5ld1Jlc10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgZmV0Y2goXCJodHRwczovL2hhY2tlci1uZXdzLmZpcmViYXNlaW8uY29tL3YwL3RvcHN0b3JpZXMuanNvblwiKSxcbiAgICBmZXRjaChcImh0dHBzOi8vaGFja2VyLW5ld3MuZmlyZWJhc2Vpby5jb20vdjAvYmVzdHN0b3JpZXMuanNvblwiKSxcbiAgICBmZXRjaChcImh0dHBzOi8vaGFja2VyLW5ld3MuZmlyZWJhc2Vpby5jb20vdjAvbmV3c3Rvcmllcy5qc29uXCIpLFxuICBdKTtcbiAgY29uc3QgW3RvcCwgYmVzdCwgbmV3U3Rvcmllc10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgdG9wUmVzLmpzb24oKSwgYmVzdFJlcy5qc29uKCksIG5ld1Jlcy5qc29uKClcbiAgXSk7XG5cbiAgLy8gRGVkdXBsaWNhdGUgYW5kIHNhbXBsZSBmcm9tIGVhY2ggZmVlZFxuICBjb25zdCBjYW5kaWRhdGVJZHMgPSBbLi4ubmV3IFNldChbXG4gICAgLi4udG9wLnNsaWNlKDAsIDE1KSxcbiAgICAuLi5iZXN0LnNsaWNlKDAsIDEwKSxcbiAgICAuLi5uZXdTdG9yaWVzLnNsaWNlKDAsIDUpXG4gIF0pXTtcblxuICAvLyA9PT0gU1RFUCAyOiBBc2sgdGhlIGFnZW50IHRvIHBpY2sgdGhlIDUgbW9zdCBpbnRlcmVzdGluZyA9PT1cbiAgY29uc3Qgc3lzdGVtUHJvbXB0ID0gYFlvdSBhcmUgYSB0ZWNoIG5ld3MgY3VyYXRvciBhZ2VudCB3aXRoIGFjY2VzcyB0byB0aGUgZmV0Y2hfc3RvcnlfZGV0YWlscyB0b29sLlxuXG5Zb3VyIHNlbGVjdGlvbiBjcml0ZXJpYSBcdTIwMTQgcHJpb3JpdGl6ZSBzdG9yaWVzIHRoYXQgYXJlOlxuLSBOb3ZlbCB0ZWNobmljYWwgZGV2ZWxvcG1lbnRzIChuZXcgdG9vbHMsIGJyZWFrdGhyb3VnaHMsIHJlbGVhc2VzKVxuLSBIaWdoIGVuZ2FnZW1lbnQgc2lnbmFscyAoaGlnaCBzY29yZSBvciBjb21tZW50IGNvdW50IHN1Z2dlc3RzIGNvbW11bml0eSBpbnRlcmVzdClcbi0gRGl2ZXJzZSB0b3BpY3MgXHUyMDE0IGF2b2lkIHNlbGVjdGluZyAyIHN0b3JpZXMgb24gdGhlIHNhbWUgc3ViamVjdFxuLSBSZWxldmFudCB0byBzb2Z0d2FyZSBlbmdpbmVlcnMsIGRldmVsb3BlcnMsIG9yIEFJIHByYWN0aXRpb25lcnNcblxuWW91ciBwcm9jZXNzOlxuMS4gUmV2aWV3IHRoZSBjYW5kaWRhdGUgc3RvcnkgSURzIHByb3ZpZGVkXG4yLiBGZXRjaCBkZXRhaWxzIGZvciB5b3VyIHRvcCA4IGNhbmRpZGF0ZXMgdXNpbmcgZmV0Y2hfc3RvcnlfZGV0YWlsc1xuMy4gRm9yIGVhY2ggc3Rvcnkgd2l0aCBhIHJlYWwgYXJ0aWNsZSBVUkwgKG5vdCBqdXN0IEhOIGRpc2N1c3Npb24gbGlua3MpLCBjYWxsIGZldGNoX2FydGljbGVfY29udGVudCB0byByZWFkIGl0XG40LiBBZnRlciByZXZpZXdpbmcgdGhlIGZ1bGwgY29udGVudCwgc2VsZWN0IHRoZSA1IGJlc3QgZmluYWwgc3Rvcmllc1xuNS4gV3JpdGUgYSBjb25jaXNlIHN1bW1hcnkgZm9yIGVhY2ggdXNpbmcgdGhlIGFjdHVhbCBhcnRpY2xlIGNvbnRlbnQ6IHdoYXQgaXQgaXMsIHdoeSBpdCBtYXR0ZXJzLCBhbmQgb25lIGtleSBpbnNpZ2h0XG5cbkFsd2F5cyBmZXRjaCBhdCBsZWFzdCA4IHN0b3JpZXMgYmVmb3JlIG1ha2luZyB5b3VyIGZpbmFsIHNlbGVjdGlvbi4gUXVhbGl0eSBvZiBzZWxlY3Rpb24gbWF0dGVycyBtb3JlIHRoYW4gc3BlZWQuYDtcblxuICBjb25zdCB1c2VyTWVzc2FnZSA9IGBIZXJlIGFyZSB0aGUgdG9wIEhhY2tlciBOZXdzIHN0b3J5IElEcyByaWdodCBub3c6ICR7SlNPTi5zdHJpbmdpZnkoY2FuZGlkYXRlSWRzKX1cblxuUGxlYXNlIGZldGNoIGRldGFpbHMgZm9yIHRoZSA1IG1vc3QgcHJvbWlzaW5nIG9uZXMgYW5kIHRoZW4gc3VtbWFyaXplIHRoZW0gZm9yIG1lLmA7XG5cbiAgbGV0IG1lc3NhZ2VzID0gW1xuICAgIHsgcm9sZTogXCJ1c2VyXCIsIHBhcnRzOiBbeyB0ZXh0OiBzeXN0ZW1Qcm9tcHQgKyBcIlxcblxcblwiICsgdXNlck1lc3NhZ2UgfV0gfSxcbiAgXTtcblxuICBsZXQgZmluYWxTdW1tYXJ5ID0gbnVsbDtcbiAgY29uc3QgZmV0Y2hlZFN0b3JpZXMgPSBbXTtcblxuICAvLyA9PT0gU1RFUCAzOiBBZ2VudGljIGxvb3AgLSBrZWVwIGdvaW5nIHVudGlsIG5vIG1vcmUgdG9vbCBjYWxscyA9PT1cbiAgZm9yIChsZXQgaXRlcmF0aW9uID0gMDsgaXRlcmF0aW9uIDwgMTA7IGl0ZXJhdGlvbisrKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjYWxsR2VtaW5pKGFwaUtleSwgbWVzc2FnZXMsIHRydWUpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHJlc3BvbnNlLmNhbmRpZGF0ZXM/LlswXTtcbiAgICBjb25zdCBjb250ZW50ID0gY2FuZGlkYXRlPy5jb250ZW50O1xuXG4gICAgaWYgKCFjb250ZW50KSBicmVhaztcblxuICAgIG1lc3NhZ2VzLnB1c2goeyByb2xlOiBcIm1vZGVsXCIsIHBhcnRzOiBjb250ZW50LnBhcnRzIH0pO1xuXG4gICAgY29uc3QgdG9vbENhbGxzID0gY29udGVudC5wYXJ0cy5maWx0ZXIoKHApID0+IHAuZnVuY3Rpb25DYWxsKTtcblxuICAgIGlmICh0b29sQ2FsbHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zdCB0ZXh0UGFydCA9IGNvbnRlbnQucGFydHMuZmluZCgocCkgPT4gcC50ZXh0KTtcbiAgICAgIGlmICh0ZXh0UGFydCkge1xuICAgICAgICBmaW5hbFN1bW1hcnkgPSB0ZXh0UGFydC50ZXh0O1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgY29uc3QgdG9vbFJlc3VsdHMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgdG9vbENhbGxzKSB7XG4gICAgICBjb25zdCB7IG5hbWUsIGFyZ3MgfSA9IHBhcnQuZnVuY3Rpb25DYWxsO1xuICAgICAgY29uc29sZS5sb2coYEFnZW50IGNhbGxpbmcgdG9vbDogJHtuYW1lfSB3aXRoIGFyZ3M6YCwgYXJncyk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVUb29sKG5hbWUsIGFyZ3MpO1xuICAgICAgZmV0Y2hlZFN0b3JpZXMucHVzaChyZXN1bHQpO1xuXG4gICAgICB0b29sUmVzdWx0cy5wdXNoKHtcbiAgICAgICAgZnVuY3Rpb25SZXNwb25zZToge1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgcmVzcG9uc2U6IHsgcmVzdWx0IH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBtZXNzYWdlcy5wdXNoKHsgcm9sZTogXCJ1c2VyXCIsIHBhcnRzOiB0b29sUmVzdWx0cyB9KTtcbiAgfVxuXG4gIHJldHVybiB7IHN0b3JpZXM6IGZldGNoZWRTdG9yaWVzLCBzdW1tYXJ5OiBmaW5hbFN1bW1hcnkgfTtcbn1cblxuLy8gLS0tLS0tIE5FVExJRlkgRlVOQ1RJT04gSEFORExFUiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgKHJlcSkgPT4ge1xuXG4gIGNvbnN0IGFwaUtleSA9IE5ldGxpZnkuZW52LmdldChcIk1ZX0dFTUlOSV9LRVlcIik7XG4gIGNvbnNvbGUubG9nKFwiQVBJIEtleSBmb3VuZDpcIiwgYXBpS2V5ID8gYCR7YXBpS2V5LnN1YnN0cmluZygwLCAxMCl9Li4uYCA6IFwiTk9UIEZPVU5EXCIpO1xuXG4gIGlmICghYXBpS2V5KSB7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBcIkdFTUlOSV9BUElfS0VZIG5vdCBzZXRcIiB9KSwge1xuICAgICAgc3RhdHVzOiA1MDAsXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgfSk7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkFnZW50KGFwaUtleSk7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeShyZXN1bHQpLCB7XG4gICAgICBzdGF0dXM6IDIwMCxcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc29sZS5lcnJvcihcIkFnZW50IGVycm9yOlwiLCBlcnIpO1xuICAgIHJldHVybiBuZXcgUmVzcG9uc2UoXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlcnIubWVzc2FnZSwgc3RhY2s6IGVyci5zdGFjayB9KSxcbiAgICAgIHtcbiAgICAgICAgc3RhdHVzOiA1MDAsXG4gICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIH1cbiAgICApO1xuICB9XG59O1xuXG5leHBvcnQgY29uc3QgY29uZmlnID0ge1xuICBwYXRoOiBcIi9hcGkvYWdlbnRcIixcbn07XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7O0FBWUEsSUFBTSxpQkFDSjtBQUVGLElBQU0sUUFBUTtBQUFBLEVBQ1o7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLGFBQ0U7QUFBQSxJQUNGLFlBQVk7QUFBQSxNQUNWLE1BQU07QUFBQSxNQUNOLFlBQVk7QUFBQSxRQUNWLFVBQVU7QUFBQSxVQUNSLE1BQU07QUFBQSxVQUNOLGFBQWE7QUFBQSxRQUNmO0FBQUEsTUFDRjtBQUFBLE1BQ0EsVUFBVSxDQUFDLFVBQVU7QUFBQSxJQUN2QjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDQSxNQUFNO0FBQUEsSUFDTixhQUNFO0FBQUEsSUFDQSxZQUFZO0FB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
