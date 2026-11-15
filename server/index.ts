import express from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.AI_READER_MODEL ?? "claude-opus-5-5";
const PORT = Number(process.env.PORT ?? 8787);
const MAX_PDF_BYTES = 32 * 1024 * 1024; // Claude API request limit for PDFs

const client = new Anthropic();
const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Document store (in memory; MVP) ----
interface StoredDoc {
  id: string;
  name: string;
  base64: string;
}
const docs = new Map<string, StoredDoc>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
});

app.post("/api/docs", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return void res.status(400).json({ error: "没有收到文件" });
  if (file.mimetype !== "application/pdf" && !file.originalname.toLowerCase().endsWith(".pdf")) {
    return void res.status(400).json({ error: "目前只支持 PDF" });
  }
  // multer decodes the filename as latin1; restore UTF-8 (Chinese names etc.)
  const name = Buffer.from(file.originalname, "latin1").toString("utf8");
  const id = randomUUID();
  docs.set(id, { id, name, base64: file.buffer.toString("base64") });
  res.json({ docId: id, name });
});

// ---- Chat (SSE streaming) ----
interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
interface ChatBody {
  docId: string;
  messages: ChatTurn[];
}

const SYSTEM_PROMPT = `你是一个嵌在 PDF 阅读器里的阅读助手。用户正在阅读随附的 PDF 文档，你的工作是帮助他们读懂它。

- 默认用简体中文回答；如果用户用别的语言提问，就用那种语言回答。
- 用通俗易懂的大白话解释，必要时举例或打比方；术语第一次出现时顺带解释。
- 回答要基于文档内容。涉及文档里的具体说法时，引用原文，方便用户回到原文核对。
- 文档里没有的信息，要明确说"文档里没有提到"，再给出你自己的知识，并标明这是补充。
- 用户消息里可能带有【当前页】和【选中文本】，这是用户此刻正在看的位置，优先围绕它回答。
- 回答尽量简洁，用 Markdown 排版（小标题、列表），不要写客套话。`;

function sse(res: express.Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.post("/api/chat", async (req, res) => {
  const { docId, messages } = req.body as ChatBody;
  const doc = docs.get(docId);
  if (!doc) return void res.status(404).json({ error: "doc_not_found" });
  if (!Array.isArray(messages) || messages.length === 0 || messages.at(-1)?.role !== "user") {
    return void res.status(400).json({ error: "messages 格式不对" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // The PDF goes first in the first user turn and is cached, so follow-up
  // questions re-read it from the prompt cache instead of paying full price.
  const apiMessages: Anthropic.Beta.BetaMessageParam[] = messages.map((m, i) =>
    i === 0
      ? {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: doc.base64 },
              title: doc.name,
              citations: { enabled: true },
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: m.content },
          ],
        }
      : { role: m.role, content: m.content },
  );

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        output_config: { effort: "medium" },
        // If the main model declines, the API retries on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: apiMessages,
      },
      { signal: abort.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "text") {
        sse(res, { type: "segment" });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          sse(res, { type: "text", text: event.delta.text });
        } else if (event.delta.type === "citations_delta") {
          const c = event.delta.citation;
          if (c.type === "page_location") {
            sse(res, {
              type: "citation",
              page: c.start_page_number,
              endPage: Math.max(c.start_page_number, c.end_page_number - 1),
              text: c.cited_text,
            });
          }
        }
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      sse(res, { type: "error", message: "模型拒绝回答这个请求。" });
    } else if (final.stop_reason === "max_tokens") {
      sse(res, { type: "error", message: "回答太长被截断了。" });
    }
    sse(res, { type: "done", usage: final.usage });
  } catch (err) {
    if (abort.signal.aborted) return;
    let message = "调用 AI 失败";
    if (err instanceof Anthropic.AuthenticationError) message = "API Key 无效或未配置（设置 ANTHROPIC_API_KEY）";
    else if (err instanceof Anthropic.RateLimitError) message = "请求太频繁，稍后再试";
    else if (err instanceof Anthropic.BadRequestError) message = `请求被拒绝：${err.message}`;
    else if (err instanceof Anthropic.APIError) message = `API 错误 ${err.status}：${err.message}`;
    else if (err instanceof Error) message = err.message;
    console.error(err);
    sse(res, { type: "error", message });
  } finally {
    res.end();
  }
});

// ---- Serve the built frontend in production ----
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
app.use(express.static(dist));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => {
  console.log(`AI Reader server: http://localhost:${PORT}  (model: ${MODEL})`);
});
