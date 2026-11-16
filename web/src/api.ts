export interface Citation {
  page: number;
  endPage: number;
  text: string;
}

/** One text block of an answer; citations point back to PDF pages. */
export interface Segment {
  text: string;
  citations: Citation[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  /** What the user sees in the chat bubble. */
  display: string;
  /** What is actually sent to the model (may include page / selection context). */
  content: string;
  segments?: Segment[];
  error?: string;
  pending?: boolean;
}

export async function uploadPdf(file: File): Promise<{ docId: string; name: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/docs", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "上传失败");
  return data;
}

export type StreamEvent =
  | { type: "segment" }
  | { type: "text"; text: string }
  | ({ type: "citation" } & Citation)
  | { type: "error"; message: string }
  | { type: "done" };

/** POST /api/chat and yield server-sent events as they arrive. */
export async function* streamChat(
  docId: string,
  messages: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, messages }),
    signal,
  });
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `请求失败 (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6)) as StreamEvent;
    }
  }
}

export class DocNotFoundError extends Error {
  constructor() {
    super("doc_not_found");
  }
}
