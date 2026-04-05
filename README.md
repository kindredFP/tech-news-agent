# Tech News Agent

Tech News Agent is a simple serverless AI agent built with JavaScript and deployed on Netlify. It uses the Hacker News API to gather top stories, then uses Google Gemini to identify notable tech news and generate short summaries and insights.

This project was created to demonstrate core agent concepts in a practical way: tool usage, multi-step decision flow, server-side LLM integration, and clean deployment with environment variables. It is intentionally lightweight, easy to understand, and built using free-tier friendly services.

## Project structure

- `index.html` — main front-end page
- `netlify.toml` — Netlify configuration
- `netlify/functions/agent.mjs` — serverless function used by the app
- `package.json` — project metadata and dev script

## Requirements

- Node.js
- Netlify CLI (optional, for local development)

## Local development

Install dependencies:

```bash
npm install
```

Start the local dev server:

```bash
npm run dev
```

Open the local URL shown by Netlify CLI, typically `http://localhost:8888`.

## Deployment

This project is set up for Netlify deployment. Push the repo to a Git provider and connect it to a Netlify site.

Netlify will use `netlify.toml` and the `netlify/functions` directory for the serverless function.

## Notes

- The app is a static single-page UI served from `index.html`.
- The function in `netlify/functions/agent.mjs` handles backend logic.
