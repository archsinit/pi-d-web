import { EventEmitter } from "node:events";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const isId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// Account-private Unix IPC. Bounded frames and write queues prevent a slow peer
// from retaining an unbounded copy of a transcript.
export class JsonPeer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = "";
    this.closed = new Promise((resolve) => socket.once("close", () => { this.emit("close"); resolve(); }));
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { this.destroy(); return; }
        try {
          const frame = JSON.parse(line);
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid frame");
          this.emit("message", frame);
        } catch { this.destroy(); return; }
      }
      if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.destroy();
    });
  }

  send(frame) {
    if (this.socket.destroyed) return false;
    const text = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES || this.socket.writableLength > MAX_FRAME_BYTES * 2) {
      this.destroy(); return false;
    }
    this.socket.write(text);
    return true;
  }

  destroy() { this.socket.destroy(); }
}
