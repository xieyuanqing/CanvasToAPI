const { EventEmitter } = require("events");

class SSEConnection extends EventEmitter {
    constructor(token, res, options = {}) {
        super();
        this.token = token;
        this.res = res;
        this.meta = options.meta || {};
        this.readyState = 1;
        this._closed = false;
        this._heartbeatTimer = null;
    }

    send(message) {
        if (this.readyState !== 1) {
            return false;
        }

        try {
            const payload = typeof message === "string" ? message : JSON.stringify(message);
            this.res.write(`data: ${payload}\n\n`);
            return true;
        } catch (error) {
            this.emit("error", error);
            this.close(1011, "send_failed");
            return false;
        }
    }

    sendEvent(eventName, payload) {
        if (this.readyState !== 1) {
            return false;
        }

        try {
            if (eventName) {
                this.res.write(`event: ${eventName}\n`);
            }

            const data = typeof payload === "string" ? payload : JSON.stringify(payload);
            this.res.write(`data: ${data}\n\n`);
            return true;
        } catch (error) {
            this.emit("error", error);
            this.close(1011, "send_failed");
            return false;
        }
    }

    sendComment(comment = "ping") {
        if (this.readyState !== 1) {
            return;
        }

        this.res.write(`: ${comment}\n\n`);
    }

    setHeartbeat(intervalMs = 20000) {
        this.clearHeartbeat();
        this._heartbeatTimer = setInterval(() => {
            try {
                this.sendComment("ping");
            } catch (error) {
                this.emit("error", error);
                this.close(1011, "heartbeat_failed");
            }
        }, intervalMs);
    }

    clearHeartbeat() {
        if (!this._heartbeatTimer) {
            return;
        }

        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    receiveFromBrowser(message) {
        if (this.readyState !== 1) {
            return;
        }

        const payload = typeof message === "string" ? message : JSON.stringify(message);
        this.emit("message", payload);
    }

    close(code = 1000, reason = "closed") {
        if (this._closed) {
            return;
        }

        this._closed = true;
        this.readyState = 3;
        this.clearHeartbeat();

        try {
            if (!this.res.writableEnded) {
                this.res.end();
            }
        } catch (error) {
            this.emit("error", error);
        }

        this.emit("close", code, reason);
    }
}

module.exports = SSEConnection;
