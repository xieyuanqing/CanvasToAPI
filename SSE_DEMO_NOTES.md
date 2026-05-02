# SSE Demo Notes

## What changed

- Added parallel SSE browser transport support without removing the existing `/ws` WebSocket path.
- Added `src/core/SSEConnection.js` as a WebSocket-like adapter for `SessionRegistry`.
- Added `src/core/SSETransport.js` with:
  - `POST /browser/auth`
  - `GET /browser/events/:token`
  - `POST /browser/messages`
- Added `scripts/client/canvas_sse.html` as the browser demo page for the SSE transport.

## How to use

1. Install dependencies if needed: `npm install --ignore-scripts`.
2. Start the demo server on a non-production port, for example:

   ```bash
   PORT=7862 HOST=127.0.0.1 API_KEYS=123456 STREAMING_MODE=fake node main.js
   ```

3. Open `scripts/client/canvas_sse.html` in the browser session that carries Gemini.
4. Set the endpoint to the server origin, for example `http://127.0.0.1:7862` or an HTTPS origin exposed by your reverse proxy.
5. Enter the same API key used for API requests.
6. Connect and wait for the session to show as authenticated.

## Transport flow

- Browser bootstraps with `POST /browser/auth`.
- Server returns a short-lived token and `/browser/events/:token`.
- Browser opens `EventSource` to `/browser/events/:token`.
- Server sends `transport_open`.
- Browser sends the existing `authenticate` message through `POST /browser/messages`.
- After auth succeeds, request/response traffic reuses the existing browser message schema.

## Message shape

`POST /browser/messages` expects:

```json
{
  "token": "session-bootstrap-token",
  "message": {
    "event_type": "authenticate|response_headers|chunk|error|stream_close",
    "request_id": "..."
  }
}
```

## Validation performed

- `node --check` passed for `src/core/SSEConnection.js`, `src/core/SSETransport.js`, `src/core/ProxyServerSystem.js`, and `src/core/SessionRegistry.js`.
- Inline script syntax check passed for `scripts/client/canvas_sse.html`.
- `npx eslint` passed for the changed server files.
- Startup smoke passed with `PORT=7862 HOST=127.0.0.1 API_KEYS=123456 STREAMING_MODE=fake node main.js`.
- SSE auth smoke passed:
  - `POST /browser/auth` returned a token and events URL.
  - `GET /browser/events/:token` returned `transport_open` as a default SSE message.
  - `POST /browser/messages` with `authenticate` returned `204`.
  - The SSE stream returned `auth_ack` with `authorized: true`.
- WebSocket compatibility smoke passed by connecting to `ws://127.0.0.1:7862/ws` and receiving `auth_ack` with `authorized: true`.

## Limitations

- This is a demo transport only; pending token and active connection state are in-memory.
- Token TTL is fixed at 5 minutes.
- SSE is one-way, so browser upstream traffic uses individual `fetch` POSTs and does not have WebSocket-style backpressure semantics.
- `canvas_sse.html` is a fork of the current client page, so future UI changes to `canvas.html` will need to be mirrored if this demo is kept.
- A real Gemini request through `canvas_sse.html` still needs to be tested inside the actual Canvas page/browser session.
