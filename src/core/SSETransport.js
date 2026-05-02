const { randomUUID } = require("crypto");
const SSEConnection = require("./SSEConnection");

class SSETransport {
    constructor({ logger, sessionRegistry, buildBrowserSessionMeta }) {
        this.logger = logger;
        this.sessionRegistry = sessionRegistry;
        this.buildBrowserSessionMeta = buildBrowserSessionMeta;
        this.pendingTokens = new Map();
        this.connectionsByToken = new Map();
        this.tokenTtlMs = 5 * 60 * 1000;
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
    }

    _handleAuth(req, res) {
        this._cleanupExpiredTokens();

        const clientLabel = typeof req.body?.clientLabel === "string" ? req.body.clientLabel.trim().slice(0, 64) : "";
        const token = randomUUID();
        const expiresAt = Date.now() + this.tokenTtlMs;
        const meta = {
            ...this.buildBrowserSessionMeta(req),
            clientLabel,
            transport: "sse",
        };

        this.pendingTokens.set(token, {
            apiKey: typeof req.body?.apiKey === "string" ? req.body.apiKey : "",
            clientLabel,
            createdAt: Date.now(),
            expiresAt,
            meta,
        });

        this.logger.info(
            `[SSE] Issued browser token for ${meta.address || "unknown address"} (${clientLabel || "unlabeled"})`
        );

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

    _cleanupExpiredTokens() {
        const now = Date.now();

        for (const [token, entry] of this.pendingTokens.entries()) {
            if (entry.expiresAt > now) {
                continue;
            }

            this.pendingTokens.delete(token);
        }
    }
}

module.exports = SSETransport;
