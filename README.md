# Tech News Agent 🤖

[![Netlify Status](https://api.netlify.com/api/v1/badges/3bf99d48-483f-4759-aed8-f097a5b947db/deploy-status)](https://app.netlify.com/projects/tech-news-agent/deploys)

A working AI agent that autonomously curates and summarizes the most relevant tech stories from Hacker News using Google Gemini. Built as a portfolio project to demonstrate real agentic architecture patterns — not just a chatbot, but a system where the LLM drives a multi-step tool-use loop.

**Live demo**: https://tech-news-agent.netlify.app

## 🤖 What Makes This an Agent?

Most LLM apps send one prompt and get one response. This project implements a genuine **agentic loop**:

```
1. Fetch 30 candidate story IDs from Hacker News (top, best, new feeds)
2. LLM decides which 8 stories are worth investigating
3. Agent executes fetch_story_details tool for each — in a loop
4. Agent executes fetch_article_content tool to read the actual article content
5. LLM evaluates the full details and selects the best 5
6. LLM synthesizes a final summary with key insights
```

The LLM is actively driving the process — choosing what to fetch, evaluating results, and deciding when it has enough information. That's what distinguishes an agent from a single prompt.

## ✨ Features

- **Multi-source curation**: Pulls from Hacker News top, best, and new feeds for diverse coverage
- **Intelligent selection**: Gemini evaluates 30+ candidates and selects the 5 most relevant stories
- **Smart filtering**: Prioritizes novel technical developments, high-engagement content, and developer-relevant topics
- **Automated summaries**: Concise summaries covering what it is, why it matters, and key insights
- **Serverless**: Built on Netlify Functions — no server to manage, scales automatically

## 🏗️ Architecture

```
index.html  →  /api/agent (Netlify Function)  →  Gemini 2.5 Flash
                      ↕ tool-use loop
               Hacker News Firebase API
```

The agent function (`netlify/functions/agent.mjs`) implements the full loop:

| Step | What happens |
|------|-------------|
| 1 | Fetch story IDs from 3 HN feeds in parallel |
| 2 | Send candidate IDs to Gemini with tool definitions |
| 3 | Gemini calls `fetch_story_details` tool for chosen IDs |
| 4 | Gemini calls `fetch_article_content` to read actual article text |
| 5 | Function executes each tool call, feeds results back |
| 6 | Loop continues until Gemini stops calling tools |
| 7 | Gemini writes final summaries, function returns JSON |

## 🚀 Quick Start

### Prerequisites

- Node.js v16+
- [Netlify CLI](https://docs.netlify.com/cli/get-started/): `npm install -g netlify-cli`
- Google Gemini API key from [Google AI Studio](https://aistudio.google.com) (free tier)

### Installation

```bash
git clone https://github.com/kindredFP/tech-news-agent.git
cd tech-news-agent
npm install
```

### Environment Setup

Create a `.env` file in the project root:

```
MY_GEMINI_KEY=your_gemini_api_key_here
```

> **Note on variable naming**: The variable is named `MY_GEMINI_KEY` instead of the conventional `GEMINI_API_KEY` because Netlify's local AI Gateway automatically intercepts and overwrites `GEMINI_API_KEY` with its own JWT token when running `netlify dev`. Using a custom name bypasses this. On the deployed site, either name works fine — this only affects local development.

### Local Development

```bash
netlify login        # authenticate with Netlify
netlify link         # link to your Netlify project
netlify dev          # start local dev server
```

Open http://localhost:8888 and click **Run Agent**.

### Deployment

```bash
# Set the env var in Netlify
netlify env:set MY_GEMINI_KEY your_gemini_api_key_here

# Deploy to production
netlify deploy --prod
```

## 📁 Project Structure

```
tech-news-agent/
├── index.html                  # Dashboard UI
├── netlify.toml                # Netlify config
├── package.json
├── .env                        # Local env vars (never commit this)
└── netlify/
    └── functions/
        └── agent.mjs           # Agent brain — tool loop lives here
```

## 🛠️ Tech Stack

| Layer | Tool | Cost |
|-------|------|------|
| Frontend | Vanilla HTML/CSS/JS | Free |
| Serverless functions | Netlify Functions | Free tier |
| LLM | Google Gemini 2.5 Flash | Free tier |
| News data | Hacker News Firebase API | Free, no key needed |
| Hosting | Netlify | Free tier |

Total cost: **$0**

## 🔧 Customization

Edit the system prompt in `netlify/functions/agent.mjs` to change:
- Number of candidate stories evaluated (currently 30)
- Number of stories fetched in detail (currently 8)
- Number of final stories returned (currently 5)
- Selection criteria and topic preferences
- Summary format and length
- Whether to fetch full article content (fetch_article_content tool)

## 🐛 Known Gotchas

**Netlify AI Gateway intercepts `GEMINI_API_KEY` locally**
When running `netlify dev`, Netlify injects its own AI Gateway JWT as the value of `GEMINI_API_KEY`, overwriting your `.env` value. This causes `API key not valid` errors from Gemini. The fix is to use a differently-named variable (`MY_GEMINI_KEY`) for local development. This does not affect production deployments.

**Agent takes 20–40 seconds to respond**
This is expected — the agent now makes multiple sequential calls to Gemini, the Hacker News API, and fetches actual article content. The 30-second function timeout in `netlify.toml` accommodates this. The UI shows a live activity log so users can see progress.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push and open a Pull Request

## 📄 License

MIT License — free to use and modify.

## 🙏 Acknowledgments

- [Hacker News](https://news.ycombinator.com/) for the free API
- [Google Gemini](https://ai.google.dev/) for the LLM
- [Netlify](https://netlify.com/) for the serverless platform
