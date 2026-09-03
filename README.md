# AI Chat (Local Next.js)

## Run

Double-click:

```bat
run-local.bat
```

To stop the local server:

```bat
stop-local.bat
```

Or, if npm is available on PATH, run from this folder:

```bash
npm run dev
```

`run-local.ps1` prefers the bundled portable Node 20 runtime in `.codex-tools/node20` when present.

## Gemini Flash and DOS (2026-09-03)

- The Flash option is now `gemini-3.8-flash` in both the web UI and DOS (`run-dos.bat`, then `/model`). Gemini 2.5 Pro and the default Gemini 3.1 Pro remain available.
- Existing 3.7/older Flash settings automatically migrate to 3.8 without changing the saved reasoning selection. Model aliases in environment overrides also resolve to 3.8.
- Flash LOW/MID/HIGH send `thinkingLevel: low/medium/high`. The local LOW value `0` is a preset, not disabled thinking. Unsupported `minimal`, numeric thinking budgets and sampling parameters are not sent to 3.8.
- Memory summaries, character memory, relationship refresh, suggestions and novel exports use the same current Flash model.
- Standard 3.8 pricing is $0.75 input / $3.75 output per million tokens through 2026-12-31, then $1.50 / $7.50 from 2027-01-01. Output includes reasoning; displayed costs remain estimates.
- After pulling, run `npm run build` and restart the web/DOS server so it uses the new build.

References: [model and supported options](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [migration guide](https://ai.google.dev/gemini-api/docs/latest-model), [pricing](https://ai.google.dev/gemini-api/docs/pricing).

## Required env (`.env.local`)

Vertex AI ADC mode:

```bash
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
```

Install Google Cloud CLI and run:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project your-project-id
```

`GEMINI_API_KEY` is not required when `GOOGLE_GENAI_USE_VERTEXAI=true` and ADC is configured.

Vertex API key / express mode fallback:

```bash
GOOGLE_GENAI_USE_VERTEXAI=true
VERTEX_API_KEY=...
```

Do not use the project display name like `My First Project`; use the project ID.

## Local mode

- Login is bypassed automatically.
- FriendFee/points billing is disabled.
- The local user email defaults to `godhotyes@gmail.com` so existing local DB rows remain visible. To change it, set `LOCAL_USER_EMAIL=you@example.com` in `.env.local`.
