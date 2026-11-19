import { afterEach, describe, expect, it, vi } from "vitest";
import { DocNotFoundError, streamChat } from "../web/src/api";

/** Pretend to be the server: send the SSE text in the given network chunks. */
function mockFetch(chunks: string[], status = 200) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
}

async function collect(gen: AsyncGenerator<unknown>) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("前端读取流式回答 streamChat", () => {
  it("一条消息被网络拆成几段，也能拼回来", async () => {
    mockFetch(['data: {"type":"text","te', 'xt":"你好"}\n', '\ndata: {"type":"done"}\n\n']);
    const events = await collect(streamChat("d", [{ role: "user", content: "hi" }]));
    expect(events).toEqual([{ type: "text", text: "你好" }, { type: "done" }]);
  });

  it("文档不存在（404）时抛出 DocNotFoundError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(collect(streamChat("d", []))).rejects.toBeInstanceOf(DocNotFoundError);
  });

  it("其他错误时把服务器的错误信息带出来", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "messages 格式不对" }), { status: 400 })),
    );
    await expect(collect(streamChat("d", []))).rejects.toThrow("messages 格式不对");
  });
});
