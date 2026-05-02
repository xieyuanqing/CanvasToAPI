const { randomUUID } = require("crypto");
const SSEConnection = require("./SSEConnection");

class SSETransport {
    constructor({ logger, sessionRegistry, buildBrowserSessionMeta }) {
        this.logger = logger;
        this.sessionRegistry = sessionRegistry;
        this.buildBrowserSessionMeta = buildBrowserSessionMeta;
        this.pendingTokens = new Map();
        this.connectionsByToken = new Map();
        this.authAttemptsByAddress = new Map();
        this.tokenTtlMs = 5 * 60 * 1000;
        this.maxPendingTokens = this._readPositiveInteger(process.env.SSE_PENDING_TOKEN_LIMIT, 100);
        this.authRateLimitWindowMs = this._readPositiveInteger(
            process.env.SSE_AUTH_RATE_LIMIT_WINDOW_MS,
            5 * 60 * 1000
        );
        this.authRateLimitMax = this._readPositiveInteger(process.env.SSE_AUTH_RATE_LIMIT_MAX, 30);
    }

    mount(app) {
        app.post("/browser/auth", (req, res) => this._handleAuth(req, res));
        app.get("/browser/events/:token", (req, res) => this._handleEvents(req, res));
        app.post("/browser/messages", (req, res) => this._handleMessage(req, res));
    }

    shutdown() {
        for (const connection of this.connectionsByToken.values()) {
            try {
                connection.close(1001, "server_shutdown");
            } catch (error) {
                this.logger.debug(`[SSE] Failed to close SSE connection: ${error.message}`);
            }
        }

        this.connectionsByToken.clear();
        this.pendingTokens.clear();
        this.authAttemptsByAddress.clear();
    }

    _handleAuth(req, res) {
        this._cleanupExpiredTokens();

        const clientLabel = typeof req.body?.clientLabel === "string" ? req.body.clientLabel.trim().slice(0, 64) : "";
        const meta = {
            ...this.buildBrowserSessionMeta(req),
            clientLabel,
            transport: "sse",
        };
        const clientAddress = meta.address || "unknown address";

        if (!this._recordAuthAttempt(clientAddress)) {
            this.logger.warn(`[SSE] Rate limit exceeded for browser auth from ${clientAddress}`);
            res.status(429).json({ error: { message: "Too many SSE browser auth attempts. Please retry later." } });
            return;
        }

        if (this.pendingTokens.size >= this.maxPendingTokens) {
            this.logger.warn(`[SSE] Refusing browser auth from ${clientAddress}: pending token limit reached`);
            res.status(503).json({ error: { message: "Too many pending SSE browser sessions. Please retry later." } });
            return;
        }

        const token = randomUUID();
        const expiresAt = Date.now() + this.tokenTtlMs;

        this.pendingTokens.set(token, {
            apiKey: typeof req.body?.apiKey === "string" ? req.body.apiKey : "",
            clientLabel,
            createdAt: Date.now(),
            expiresAt,
            meta,
        });

        this.logger.info(`[SSE] Issued browser token for ${clientAddress} (${clientLabel || "unlabeled"})`);

        res.status(200).json({
            eventsUrl: `/browser/events/${token}`,
            token,
        });
    }

    _handleEvents(req, res) {
        this._cleanupExpiredTokens();

        const { token } = req.params;
        const pendingEntry = this.pendingTokens.get(token);

        if (!pendingEntry) {
            res.status(404).json({ error: { message: "Invalid or expired SSE token" } });
            return;
        }

        this.pendingTokens.delete(token);

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
        }

        const connection = new SSEConnection(token, res, { meta: pendingEntry.meta });
        connection._browserToken = token;
        connection._pendingApiKey = pendingEntry.apiKey;
        const connectionId = this.sessionRegistry.addConnection(connection, pendingEntry.meta);
        this.connectionsByToken.set(token, connection);

        connection.on("close", () => {
            this.connectionsByToken.delete(token);
        });

        connection.on("error", error => {
            this.logger.warn(`[SSE] Connection error on ${connectionId}: ${error.message}`);
        });

        connection.setHeartbeat();
        connection.send({ event_type: "transport_open" });

        req.on("close", () => {
            if (connection.readyState === 1) {
                connection.close(1000, "client_closed");
            }
        });
    }

    _handleMessage(req, res) {
        const token = typeof req.body?.token === "string" ? req.body.token : "";
        const message = req.body?.message;

        if (!token || !message) {
            res.status(400).json({ error: { message: "Missing token or message" } });
            return;
        }

        const connection = this.connectionsByToken.get(token);
        if (!connection || connection.readyState !== 1) {
            res.status(404).json({ error: { message: "SSE connection not found" } });
            return;
        }

        const normalizedMessage =
            message?.event_type === "authenticate"
                ? {
                      ...message,
                      apiKey:
                          typeof message.apiKey === "string" && message.apiKey.length > 0
                              ? message.apiKey
                              : connection._pendingApiKey || "",
                  }
                : message;

        try {
            connection.receiveFromBrowser(normalizedMessage);
            res.sendStatus(204);
        } catch (error) {
            this.logger.warn(`[SSE] Failed to forward browser message: ${error.message}`);
            res.status(500).json({ error: { message: "Failed to deliver browser message" } });
        }
    }

    _recordAuthAttempt(clientAddress) {
        const now = Date.now();
        const windowStart = now - this.authRateLimitWindowMs;
        const attempts = (this.authAttemptsByAddress.get(clientAddress) || []).filter(
            timestamp => timestamp > windowStart
        );

        if (attempts.length >= this.authRateLimitMax) {
            this.authAttemptsByAddress.set(clientAddress, attempts);
            return false;
        }

        attempts.push(now);
        this.authAttemptsByAddress.set(clientAddress, attempts);
        return true;
    }

    _cleanupExpiredTokens() {
        const now = Date.now();
        const authAttemptWindowStart = now - this.authRateLimitWindowMs;

        for (const [token, entry] of this.pendingTokens.entries()) {
            if (entry.expiresAt > now) {
                continue;
            }

            this.pendingTokens.delete(token);
        }

        for (const [clientAddress, attempts] of this.authAttemptsByAddress.entries()) {
            const activeAttempts = attempts.filter(timestamp => timestamp > authAttemptWindowStart);
            if (activeAttempts.length > 0) {
                this.authAttemptsByAddress.set(clientAddress, activeAttempts);
            } else {
                this.authAttemptsByAddress.delete(clientAddress);
            }
        }
    }

    _readPositiveInteger(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}

module.exports = SSETransport;
