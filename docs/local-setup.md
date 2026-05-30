# Local Setup

Codoptic is designed to live **inside the repo you want to analyze**.

```
your-project/
├── src/
├── package.json
└── Codoptic/        ← clone this repo here
    ├── app/
    ├── lib/
    └── ...
```

When you launch the agentic explorer, the default repo path is `..` (the parent of `Codoptic/`), i.e. your project. Override with `CODOPTIC_DEFAULT_REPO_PATH` or by entering an absolute path in the UI.

## Install

```bash
git clone https://github.com/Codoptic/Codoptic.git path/to/your-project/Codoptic
cd path/to/your-project/Codoptic
cp .env.local.example .env.local      # fill in keys for whichever providers you intend to use
npm install
npm run dev
```

The dev server runs on <http://localhost:3000>.

> **Tip:** run on port 4000 with `npm run dev -- --port 4000` (or any other free port) to reserve port 3000 for npm testing by the agent.

## .env.local

Any single provider key is sufficient — switch between them in the UI.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI provider key |
| `OPENAI_MODEL` | Default OpenAI model (default `gpt-5.5`) |
| `CLAUDE_API_KEY` | Anthropic provider key |
| `CLAUDE_MODEL` | Default Anthropic model (default `opus-4.7`) |
| `GEMINI_API_KEY` | Google Gemini provider key |
| `GEMINI_MODEL` | Default Gemini model (default `gemini-3.1-pro`) |
| `GROK_API_KEY` | xAI Grok provider key |
| `GROK_MODEL` | Default Grok model (default `grok-3`) |
| `GROK_API_BASE` | Optional Grok API base (default `https://api.x.ai/v1`) |
| `MISTRAL_API_KEY` | Mistral provider key |
| `MISTRAL_MODEL` | Default Mistral model (default `mistral-large`) |
| `MISTRAL_ENDPOINT` | Optional Mistral API base (default `https://api.mistral.ai/v1`) |
| `DEEPSEEK_API_KEY` | DeepSeek provider key |
| `DEEPSEEK_MODEL` | DeepSeek model (default `deepseek-v4-pro`) |
| `DEEPSEEK_ENDPOINT` | DeepSeek API base (default `https://api.deepseek.com`) |
| `NVIDIA_API_KEY` | NVIDIA NIM provider key |
| `NVIDIA_MODEL` | NVIDIA model (default `meta/llama-3.1-70b-instruct`) |
| `NVIDIA_ENDPOINT` | NVIDIA NIM endpoint (default `https://nvidia.com`) |
| `FOUNDRY_API_KEY` | Azure AI Foundry provider key |
| `FOUNDRY_ENDPOINT` | Azure AI Foundry endpoint URL (required) |
| `FOUNDRY_MODEL` | Azure deployment name |
| `CODOPTIC_DEFAULT_PROVIDER` | Default provider (`openai` / `anthropic` / `gemini` / `grok` / `mistral` / `deepseek` / `nvidia` / `foundry`) |
| `CODOPTIC_DEFAULT_REPO_PATH` | Override the default repo path |

For provider-specific behavior (models, JSON-mode, retry semantics) see [providers.md](providers.md).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Local Next.js dev server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript without emit |
| `npm test` | Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run test:visual` | Visual regression snapshots |
| `npm run format` | Prettier |
| `npm run render:example` | Render the example diagram |

## Repository Layout

The main code is organized into a few broad areas:

- `app/` — Next.js routes, API endpoints, and top-level pages.
- `components/` — UI for the shell, editor, diagram, agent panels, inspector, and Code Space.
- `lib/dsl/` — lexer, parser, compiler, formatter, and tests for the DSL.
- `lib/layout/` — layout engines and geometry helpers.
- `lib/render/` — SVG scene generation, routing, and visual theming.
- `lib/export/` — PNG, SVG, PDF, and download helpers.
- `lib/agent/` — repo scanning, chunking, summarization, planning, provider routing, and repair loops.
- `lib/code-space/` — agentic workspace domain logic and runtime orchestration.
- `docs/` — grammar, architecture, provider, and setup documentation.
- `examples/` — sample DSL inputs and screenshots.

## Rendering And Export

The editor renders diagrams to SVG first, then reuses the same scene for export. That means:

- what you see in the browser is what gets exported,
- PNG and SVG exports stay in sync with the viewport,
- layout changes are driven by the same underlying graph and theme system.

Exports are available from the editor UI, and the current diagram can also be printed.

## Security Notes

- API keys entered in the UI live **only in server-process memory** for the current analysis. They are never written to disk and never echoed back to the browser.
- The repo scanner refuses obviously sensitive paths (`/etc`, `/var`, `~/.ssh`, etc.) and honors `.gitignore`.
- The scanner explicitly excludes `.env*`, `*.pem`, `*.key`, `*.crt`, and binaries.
- AI calls send only **selected file chunks** plus per-file summaries, not your entire repo. Per-file summaries are cached locally under `.codoptic-cache/` (added to `.gitignore`).

## Known Limitations

- Sequence and class diagrams currently reuse the same flow-layout pipeline as other diagrams.
- There is no multi-user persistence layer; projects save locally through IndexedDB or exported `.diagram.json` files.
- Provider model defaults match the values configured in the repo, but availability still depends on your account and deployment setup.
