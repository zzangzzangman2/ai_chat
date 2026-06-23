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
