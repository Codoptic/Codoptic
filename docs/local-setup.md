# Local setup

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

When you launch the agentic explorer, the default repo path is `..`
(the parent of `Codoptic/`), i.e. your project.

## Install

```bash
git clone https://github.com/Codoptic/Codoptic.git path/to/your-project/Codoptic
cd path/to/your-project/Codoptic
cp .env.local.example .env.local
# fill in keys for whichever providers you intend to use
npm install
npm run dev
```

The dev server runs on http://localhost:3000.

## .env.local

| Variable                          | Purpose                                |
|-----------------------------------|----------------------------------------|
| `OPENAI_API_KEY`                  | OpenAI provider key                    |
| `OPENAI_MODEL`                    | Default OpenAI model                   |
| `CLAUDE_API_KEY`                  | Anthropic provider key                 |
| `CLAUDE_MODEL`                    | Default Anthropic model                |
| `GEMINI_API_KEY`                  | Google Gemini provider key             |
| `GEMINI_MODEL`                    | Default Gemini model                   |
| `GROK_API_KEY`                    | xAI Grok provider key                  |
| `GROK_MODEL`                      | Default Grok model                     |
| `GROK_API_BASE`                   | Optional Grok API base (default https://api.x.ai/v1) |
| `MISTRAL_API_KEY`                 | Mistral provider key                   |
| `MISTRAL_MODEL`                   | Default Mistral model                  |
| `MISTRAL_ENDPOINT`                | Optional Mistral API base (default https://api.mistral.ai/v1) |
| `DEEPSEEK_API_KEY`                | DeepSeek provider key                  |
| `DEEPSEEK_MODEL`                  | DeepSeek model                         |
| `DEEPSEEK_ENDPOINT`               | DeepSeek API base (default https://api.deepseek.com) |
| `NVIDIA_API_KEY`                  | NVIDIA NIM provider key                |
| `NVIDIA_MODEL`                    | NVIDIA model                           |
| `NVIDIA_ENDPOINT`                 | NVIDIA NIM endpoint (default https://nvidia.com) |
| `FOUNDRY_API_KEY`                 | Azure AI Foundry provider key          |
| `FOUNDRY_ENDPOINT`                | Azure AI Foundry endpoint URL          |
| `FOUNDRY_MODEL`                   | Azure deployment name                  |
| `CODOPTIC_DEFAULT_PROVIDER`   | `openai` / `anthropic` / `gemini` / `grok` / `mistral` / `deepseek` / `nvidia` / `foundry` |
| `CODOPTIC_DEFAULT_REPO_PATH`  | Override the parent-directory default  |

Any single provider key is sufficient — switch between them in the UI.

## Scripts

| Script                  | Purpose                                  |
|-------------------------|------------------------------------------|
| `npm run dev`           | Local dev server with hot reload         |
| `npm run build`         | Production build                         |
| `npm run start`         | Run the production build                 |
| `npm run lint`          | ESLint                                   |
| `npm run typecheck`     | TypeScript without emit                  |
| `npm test`              | Vitest unit tests                        |
| `npm run test:e2e`      | Playwright end-to-end tests              |
| `npm run test:visual`   | Visual regression snapshots              |
| `npm run format`        | Prettier                                 |

## Security notes

- API keys entered in the UI live **only in server-process memory** for the
  current analysis. They are never written to disk and never echoed back to
  the browser.
- The repo scanner refuses obviously sensitive paths (`/etc`, `/var`,
  `~/.ssh`, etc.) and honors `.gitignore`.
- The scanner also explicitly excludes `.env*`, `*.pem`, `*.key`, `*.crt`,
  and binaries.
- AI calls send only **selected file chunks** plus per-file summaries, not
  your entire repo. Per-file summaries are cached locally under
  `.codoptic-cache/` (added to `.gitignore`).
