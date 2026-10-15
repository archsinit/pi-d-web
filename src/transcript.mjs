const PREVIEW_CHARS = 6000;
const CHUNK_CHARS = 48000;

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block.type === "text") return block.text ?? "";
    if (block.type === "thinking") return `[Thinking]\n${block.thinking ?? ""}`;
    if (block.type === "toolCall") return `[Tool: ${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
    if (block.type === "image") return `[Image: ${block.mimeType ?? "unknown format"}; image previews are not included]`;
    return "";
  }).filter(Boolean).join("\n\n");
}

export function entryText(entry) {
  if (entry.kind === "pi.system") return ""; // System/AGENTS prompts are not chat messages.
  if (entry.kind === "pi.reset" && !entry.model?.length) return "Conversation context reset. Earlier history remains available.";
  if (entry.model?.length) return entry.model.map((message) => contentText(message.content)).filter(Boolean).join("\n\n");
  if (entry.data !== undefined) return typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
  return "";
}

export function presentEntry(entry, offset = 0, limit = PREVIEW_CHARS) {
  if (entry.kind === "pi.system") return null;
  const message = entry.model?.[0];
  const text = entryText(entry);
  if (!text && !message) return null;
  const count = Math.min(Math.max(1, limit), CHUNK_CHARS);
  const start = Math.min(Math.max(0, offset), text.length);
  return {
    id: entry.id, kind: entry.kind,
    role: entry.kind === "pi.reset" ? "system" : entry.kind === "pi.compaction" ? "summary" : message?.role ?? "note",
    label: message?.role === "toolResult" ? message.toolName : undefined,
    timestamp: message?.timestamp,
    isError: message?.isError || message?.stopReason === "error" || undefined,
    stopReason: message?.stopReason,
    text: text.slice(start, start + count), offset: start, total: text.length,
    nextOffset: start + count < text.length ? start + count : null,
  };
}

export function presentLive(live = {}, inbox = { items: [] }) {
  const partial = live.generation?.message;
  const tools = [...(live.tools ?? []), ...(live.nestedTools ?? [])].slice(0, 20).map((tool) => ({
    callId: tool.callId, name: tool.name, status: tool.status,
    output: tool.output?.slice(-4000), droppedBytes: tool.droppedBytes,
  }));
  return {
    busy: Boolean(live.run),
    partial: partial ? contentText(partial.content).slice(-24000) : "",
    retry: live.generation?.retry ? { at: live.generation.retry.at, error: live.generation.retry.error?.slice(0, 1000) } : null,
    tools,
    compacting: Boolean(live.compactions?.length),
    compactionError: live.compactionFailure?.error?.slice(0, 1000),
    queueCount: inbox.items?.length ?? 0,
    queue: (inbox.items ?? []).slice(0, 20).map((item) => ({ id: item.id, mode: item.mode, text: contentText(item.content).slice(0, 500) })),
  };
}
