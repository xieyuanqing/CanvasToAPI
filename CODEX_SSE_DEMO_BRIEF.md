# Codex Task Brief: CanvasToAPI SSE Transport Demo

## Goal

Implement a first working demo of an SSE/HTTPS-style browser transport for `iBUHub/CanvasToAPI`, without breaking the existing WebSocket transport.

This is a local proof of concept. The current production deployment must not be touched.

The desired architecture is:

```text
Server -> Browser:  Server-Sent Events (EventSource)
Browser -> Server:  HTTPS POST / fetch
```

This replaces the browser session WebSocket bridge for test purposes while preserving the existing request/response business logic as much as possible.

## Current Repository Context

Base repo: `iBUHub/CanvasToAPI`
Current local branch: `sse-transport-demo`
Base commit: `main@60a2ca3`

High-signal files:

- `src/core/ProxyServerSystem.js`
  - Existing HTTP server and WebSocket upgrade entry.
  - Current WS path is `/ws`.
  - Do not remove existing WS logic.
- `src/core/SessionRegistry.js`
  - Owns browser connections and request queues.
  - Currently stores a `ws` object and depends on:
    - `ws.send(message)`
    - `ws.close(code, reason)`
    - `ws.readyState === 1`
    - `ws.on("message", ...)`
    - `ws.on("close", ...)`
    - `ws.on("error", ...)`
    - mutable `ws._connectionId`
- `src/core/RequestHandler.js`
  - Should ideally remain unchanged.
  - It only sends browser commands through `connection.send(...)` in methods such as `_forwardRequest()` and `_cancelBrowserRequest()`.
- `scripts/client/canvas.html`
  - Browser-side WS client and real Gemini fetch logic.
  - Create a new `scripts/client/canvas_sse.html` instead of replacing this file.
- `src/core/FormatConverter.js`
  - Do not touch unless absolutely necessary.

## Current Production Runtime Facts for Reference

Existing deployment lives at:

- `/root/.openclaw/workspace-saki/_work/canvas-to-api-vps`

Do not modify it.

It currently runs:

- `canvas-to-api`: `ghcr.io/ibuhub/canvas-to-api:v0.0.8`
- host binding: `127.0.0.1:7861 -> 7861`
- browser container: `canvas-chromium-vps`
- browser side connects to `ws://127.0.0.1:7861/ws`
- online browser session observed:
  - `browserSessionCount: 1`
  - `browserWsPath: /ws`
  - `streamingMode: fake`
  - `clientLabel: browser-FML2EQTE`

Existing local analysis file:

- `/root/.openclaw/workspace-saki/_work/canvas-to-api-vps/WS_TO_SSE_ANALYSIS_2026-05-02.md`

## Required Design

Add an SSE transport in parallel with the existing WS transport.

### New server files

Prefer adding these files:

```text
src/core/SSEConnection.js
src/core/SSETransport.js
```

A subdirectory like `src/core/transports/` is also acceptable if you update imports cleanly.

### SSEConnection requirements

`SSEConnection` should behave like a WebSocket-like adapter for `SessionRegistry`.

It should be an `EventEmitter` or otherwise expose compatible event methods.

Minimum interface:

```js
send(message)       // server -> browser, write SSE event
close(code, reason) // close SSE response and emit close
readyState          // 1 while open; 3 when closed, following WebSocket constants loosely
on("message", handler)
on("close", handler)
on("error", handler)
```

Important detail:

- Browser upstream messages arrive via `POST /browser/messages`.
- `SSETransport` should find the associated `SSEConnection` and call something like `connection.receiveFromBrowser(message)`.
- That method should internally emit `message`, so `SessionRegistry._handleIncomingMessage()` can stay mostly unchanged.

### SSETransport routes

Implement routes mounted by `ProxyServerSystem`:

1. `POST /browser/auth`

Purpose: authenticate or create a short-lived pending session token.

Request JSON:

```json
{
  "apiKey": "...",
  "clientLabel": "browser-sse-demo"
}
```

Response JSON:

```json
{
  "token": "uuid",
  "eventsUrl": "/browser/events/<token>"
}
```

For the demo, using `crypto.randomUUID()` is fine.

Token handling requirements:

- Store pending token in memory.
- TTL around 5 minutes.
- Delete token after it is consumed by the SSE connection.
- Do not log full token.

Auth behavior:

- It is okay to defer final API-key verification to the existing `SessionRegistry` auth message if that is simpler.
- But the browser should still send an `authenticate` event into the registry flow after SSE connection opens, so existing auth code is reused.

2. `GET /browser/events/:token`

Purpose: establish the SSE downlink.

Headers:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Behavior:

- Create an `SSEConnection` wrapping `res`.
- Register it with `sessionRegistry.addConnection(connection, meta)`.
- Send a first SSE event to tell the browser the transport is open, e.g.:

```json
{ "event_type": "transport_open" }
```

- Send heartbeat comments periodically, e.g. `: ping\n\n` every 15-30 seconds.
- On `req.close`, close the connection and let `SessionRegistry` remove it.

3. `POST /browser/messages`

Purpose: browser -> server upstream events.

Request JSON:

```json
{
  "token": "uuid-or-session-token",
  "message": {
    "event_type": "response_headers|chunk|error|stream_close|authenticate",
    "request_id": "..."
  }
}
```

Alternative payload shapes are fine, but keep them simple and document them.

Behavior:

- Find active `SSEConnection` by token/session id.
- Forward message into it as a synthetic `message` event.
- Return `204` or small JSON.

### ProxyServerSystem changes

- Import and instantiate `SSETransport`.
- Mount SSE routes in `_createExpressApp()`.
- Keep existing WS upgrade code unchanged.
- Be mindful of the existing auth middleware. The SSE browser routes should not be blocked before they can establish their own auth flow.
  - Either mount them before `app.use(this._createAuthMiddleware())`, or explicitly exempt `/browser/auth`, `/browser/events/*`, `/browser/messages`.

### SessionRegistry changes

Keep changes minimal.

Currently the field is called `ws`; either:

- continue storing the generic connection object in `ws`, if that keeps diff small, or
- rename to `transport` cleanly.

Do not rewrite the request queue logic.

The generic connection object must work for both WS and SSE.

### Browser client demo

Create:

```text
scripts/client/canvas_sse.html
```

Start from `scripts/client/canvas.html`, but replace only the connection manager layer.

Browser-side transport behavior:

1. On connect:
   - `POST /browser/auth` with `apiKey` and `clientLabel`.
   - Open `new EventSource(eventsUrl)`.
   - When the SSE transport is open, POST an `authenticate` message to `/browser/messages` so the existing server auth flow succeeds.
2. Downstream events:
   - Parse SSE `data:` as JSON.
   - Route received events into the same request processing logic that previously handled `WebSocket` messages.
3. Upstream messages:
   - Replace `socket.send(JSON.stringify(data))` with `fetch('/browser/messages', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ token, message: data }) })`.

Keep as much of the original request processing code as possible:

- constructing Gemini API URL
- sanitizing headers
- doing `fetch(...)` to Google
- reading response stream
- transmitting `response_headers`, `chunk`, `stream_close`, `error`

## Demo / Test Expectations

At minimum, after implementation:

1. Project starts with `npm install` / `npm start` or existing repo start command.
2. Existing WS transport remains available.
3. `scripts/client/canvas_sse.html` can connect to the server using SSE.
4. `/health` still works.
5. The server status should count the SSE browser session as connected/authenticated.
6. A simple OpenAI-compatible request should route through the SSE browser session.

Suggested quick test request once browser session is connected:

```bash
curl -s http://127.0.0.1:7862/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 123456' \
  -d '{"model":"gemini-3-flash-preview-minimal-fake","messages":[{"role":"user","content":"reply pong only"}],"stream":false}'
```

Use port `7862` for local demo if possible, so it does not conflict with current production `7861`.

## Important Constraints

- Do not touch `/root/.openclaw/workspace-saki/_work/canvas-to-api-vps`.
- Do not stop/restart existing Docker containers.
- Do not remove the WebSocket path.
- Do not rewrite `RequestHandler.js` or `FormatConverter.js` unless absolutely necessary.
- Keep implementation intentionally small and auditable.
- If there is a tradeoff, prioritize a working demo over perfect abstraction.

## Deliverables

1. Implement code changes in this working tree.
2. Add a short note in `SSE_DEMO_NOTES.md` explaining:
   - changed files
   - routes added
   - how to run locally on port 7862
   - how to open/use `canvas_sse.html`
   - known limitations
3. Run at least syntax checks / startup smoke checks if possible.
4. Report what was tested and what remains untested.
