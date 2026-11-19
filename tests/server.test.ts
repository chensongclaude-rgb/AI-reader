import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, type AiClient } from "../server/app";

// A fake Claude client: replays scripted stream events instead of calling the real API,
// so the tests are free, fast and need no API key.
let scriptedEvents: unknown[] = [];
let scriptedStopReason = "end_turn";
let lastRequest: any;
const fakeClient = {
  beta: {
    messages: {
      stream(params: unknown) {
        lastRequest = params;
        const events = scriptedEvents;
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalMessage: async () => ({ stop_reason: scriptedStopReason, usage: { input_tokens: 1 } }),
        };
      },
    },
  },
} as unknown as AiClient;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp(fakeClient).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function uploadFile(name: string, type: string) {
  const form = new FormData();
  form.append("file", new Blob(["%PDF-1.4 fake"], { type }), name);
  return fetch(`${base}/api/docs`, { method: "POST", body: form });
}

function chat(body: unknown) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Turn an SSE response body into the list of JSON events it carried. */
async function readEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)));
}

describe("上传 PDF  POST /api/docs", () => {
  it("没带文件时返回 400", async () => {
    const res = await fetch(`${base}/api/docs`, { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("没有收到文件");
  });

  it("不是 PDF 时拒绝", async () => {
    const res = await uploadFile("notes.txt", "text/plain");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("目前只支持 PDF");
  });

  it("上传 PDF 成功，中文文件名不乱码", async () => {
    const res = await uploadFile("读书笔记.pdf", "application/pdf");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.name).toBe("读书笔记.pdf");
  });
});

describe("聊天  POST /api/chat", () => {
  it("文档不存在时返回 404", async () => {
    const res = await chat({ docId: "nope", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(404);
  });

  it("最后一条不是用户消息时返回 400", async () => {
    const { docId } = await (await uploadFile("a.pdf", "application/pdf")).json();
    const res = await chat({ docId, messages: [{ role: "assistant", content: "hi" }] });
    expect(res.status).toBe(400);
  });

  it("把 AI 的流式回答转成前端要的事件，包括页码引用", async () => {
    const { docId } = await (await uploadFile("book.pdf", "application/pdf")).json();
    scriptedStopReason = "end_turn";
    scriptedEvents = [
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "第一章讲的是" } },
      {
        type: "content_block_delta",
        delta: {
          type: "citations_delta",
          // API end_page_number is exclusive; the app turns it into an inclusive page.
          citation: { type: "page_location", start_page_number: 3, end_page_number: 5, cited_text: "原文" },
        },
      },
    ];

    const res = await chat({ docId, messages: [{ role: "user", content: "讲了什么？" }] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(res);

    expect(events).toEqual([
      { type: "segment" },
      { type: "text", text: "第一章讲的是" },
      { type: "citation", page: 3, endPage: 4, text: "原文" },
      { type: "done", usage: { input_tokens: 1 } },
    ]);

    // The PDF is attached to the first user turn and marked for prompt caching.
    const first = lastRequest.messages[0].content;
    expect(first[0]).toMatchObject({ type: "document", title: "book.pdf", cache_control: { type: "ephemeral" } });
    expect(first[1]).toEqual({ type: "text", text: "讲了什么？" });
  });

  it("模型拒绝回答时告诉前端", async () => {
    const { docId } = await (await uploadFile("b.pdf", "application/pdf")).json();
    scriptedEvents = [];
    scriptedStopReason = "refusal";
    const events = await readEvents(await chat({ docId, messages: [{ role: "user", content: "x" }] }));
    expect(events[0]).toEqual({ type: "error", message: "模型拒绝回答这个请求。" });
  });
});
