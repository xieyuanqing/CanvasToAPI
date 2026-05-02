# CanvasToAPI SSE Candidate Deployment

This branch packages the SSE browser transport as an independent replacement candidate. It is designed to run beside the current WebSocket deployment until testing is complete.

## Ports and services

- Existing production service remains on `127.0.0.1:7861`.
- SSE candidate uses `127.0.0.1:7862` by default.
- Container name: `canvas-to-api-sse`.
- 1Panel network alias: `canvas-to-api-sse`.

## Run with Node for local testing

```bash
cd /root/.openclaw/workspace-saki/_work/canvas-to-api-sse-demo
npm install --ignore-scripts
npm run build:ui
PORT=7862 HOST=127.0.0.1 API_KEYS=123456 STREAMING_MODE=fake node main.js
```

Useful URLs:

- Console: `http://127.0.0.1:7862/`
- Health: `http://127.0.0.1:7862/health`
- SSE browser client page: `http://127.0.0.1:7862/browser/client/sse`
- Alias: `http://127.0.0.1:7862/canvas_sse.html`

## Run with Docker Compose

```bash
cd /root/.openclaw/workspace-saki/_work/canvas-to-api-sse-demo
cp .env.sse.example .env.sse
# edit .env.sse and set a strong API_KEYS value
set -a
. ./.env.sse
set +a
docker compose -f docker-compose.sse.yml up -d --build
```

Check:

```bash
docker compose -f docker-compose.sse.yml ps
curl http://127.0.0.1:${HOST_PORT:-7862}/health
```

## Browser client usage

Open or paste the contents of `scripts/client/canvas_sse.html` in the Gemini Canvas browser session.

Endpoint should be the server origin, not a `/ws` URL:

```text
http://127.0.0.1:7862
```

If a reverse proxy exposes the candidate over HTTPS, use:

```text
https://your-domain.example
```

Use the same API key as `API_KEYS`.

## Multi-account behavior

The SSE transport reuses the existing `SessionRegistry` and request selection logic. Multiple browser sessions are supported the same way as before:

- Keep one `canvas_sse.html` page open per browser session/account.
- Each connected page registers as an independent browser session.
- `ROUND=round` rotates across available sessions; `ROUND=random` picks randomly.

Important: this does not magically switch Google accounts inside a single browser page. If you need multiple Google accounts, each account still needs its own logged-in browser context/profile/window, just like the original browser-session architecture.

## Migration strategy

1. Keep old `canvas-to-api` on 7861 running.
2. Start `canvas-to-api-sse` on 7862.
3. Connect one or more `canvas_sse.html` browser sessions.
4. Add a test channel in new-api pointing to `http://canvas-to-api-sse:7862/v1` or local `http://127.0.0.1:7862/v1` depending on network path.
5. Run real smoke tests.
6. Only after the SSE candidate is stable, stop the old service.

## SSE auth protection knobs

The SSE browser bootstrap endpoint has lightweight in-memory protection:

- `SSE_PENDING_TOKEN_LIMIT` — maximum pending, not-yet-consumed browser tokens. Default: `100`.
- `SSE_AUTH_RATE_LIMIT_MAX` — maximum `/browser/auth` attempts per address in the rate-limit window. Default: `30`.
- `SSE_AUTH_RATE_LIMIT_WINDOW_MS` — rate-limit window in milliseconds. Default: `300000`.

## Known limitations

- SSE token/session state is in memory; browser pages need reconnect after backend restart.
- Browser upstream chunks use HTTP POST, so `STREAMING_MODE=real` may create many POSTs. `fake` is recommended for initial deployment.
- The old `/ws` transport remains available for compatibility while testing.
