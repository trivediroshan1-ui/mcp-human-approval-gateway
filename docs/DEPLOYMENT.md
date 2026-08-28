# Deployment

## Recommended public setup

- **Source and documentation:** public GitHub repository
- **Continuous verification:** GitHub Actions
- **Full application:** Render Docker web service
- **Data:** synthetic SQLite records on ephemeral storage

GitHub Pages alone is not sufficient for the full lab because Pages serves
static files while this project also requires the Node API, policy engine and
SQLite workflow service.

## GitHub

Create an empty public repository named `mcp-human-approval-gateway`. Do not
initialize it with generated files because the verified project already
contains its README, license and `.gitignore`.

After the source is pushed, GitHub Actions runs:

```bash
npm ci
npm run check
npm audit --omit=dev
```

## Render Blueprint

The repository includes `render.yaml` and a multi-stage `Dockerfile`.

1. Sign in to Render using GitHub.
2. Create a new Blueprint.
3. Select the `mcp-human-approval-gateway` repository.
4. Apply the Blueprint.
5. Wait for the Docker build and `/api/health` health check to succeed.
6. Open the generated `onrender.com` URL.

The free configuration is appropriate for a synthetic portfolio demo. Its
filesystem may be reset during redeployment or service replacement, which is
acceptable because the included records are synthetic and reproducible.

## Docker

Build:

```bash
docker build -t mcp-human-approval-gateway:0.1.0 .
```

Run:

```bash
docker run --rm -p 4174:4174 mcp-human-approval-gateway:0.1.0
```

Open `http://localhost:4174`.

For local data persistence:

```bash
docker run --rm \
  -p 4174:4174 \
  -v mcp-gateway-data:/app/data \
  mcp-human-approval-gateway:0.1.0
```

## Environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `PORT` | No | HTTP port; defaults to `4174` |
| `DATABASE_PATH` | No | SQLite path; defaults to `./data/gateway.db` |
| `AI_BASE_URL` | No | OpenAI-compatible API base URL |
| `AI_API_KEY` | No | Optional external analyst credential |
| `AI_MODEL` | No | Optional external analyst model |

Do not configure an external model for the public demonstration unless its data
handling has been reviewed. The offline deterministic analyst is the safest
default and requires no credential.
