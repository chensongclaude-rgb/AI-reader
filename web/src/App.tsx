import { useCallback, useRef, useState } from "react";
import PdfViewer, { type PdfViewerHandle, type SelectionInfo } from "./PdfViewer";
import ChatPanel from "./ChatPanel";
import { DocNotFoundError, streamChat, uploadPdf, type ChatMessage } from "./api";

interface OpenDoc {
  file: File;
  data: ArrayBuffer;
  docId: string;
  name: string;
}

type SelAction = "explain" | "translate" | "summarize" | "ask";

const SEL_PROMPTS: Record<Exclude<SelAction, "ask">, { label: string; prompt: string }> = {
  explain: { label: "解释", prompt: "用大白话解释这段话是什么意思，有术语就顺带解释，并说明它在上下文里的作用。" },
  translate: { label: "翻译", prompt: "把这段话翻译成中文（如果原文是中文就翻译成英文），保留专业术语的原文，必要时加注释。" },
  summarize: { label: "总结", prompt: "用几句话总结这段内容的要点。" },
};

const MAX_UPLOAD = 32 * 1024 * 1024;

export default function App() {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [scale, setScale] = useState(1.3);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const viewer = useRef<PdfViewerHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const docRef = useRef<OpenDoc | null>(null);
  docRef.current = doc;

  const openFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setLoadError("目前只支持 PDF 文件");
      return;
    }
    if (file.size > MAX_UPLOAD) {
      setLoadError("文件超过 32MB，AI 暂时无法处理这么大的 PDF");
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const [data, up] = await Promise.all([file.arrayBuffer(), uploadPdf(file)]);
      abortRef.current?.abort();
      setMessages([]);
      setSelection(null);
      setCurrentPage(1);
      setDoc({ file, data, docId: up.docId, name: up.name });
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /** Send a question; `content` is what the model sees, `display` what the user sees. */
  const ask = async (display: string, content: string) => {
    const d = docRef.current;
    if (!d || busy) return;
    const history: ChatMessage[] = [...messages, { role: "user", display, content }];
    const assistant: ChatMessage = { role: "assistant", display: "", content: "", segments: [], pending: true };
    setMessages([...history, assistant]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const update = (fn: (m: ChatMessage) => void) => {
      fn(assistant);
      setMessages([...history, { ...assistant, segments: assistant.segments?.map((s) => ({ ...s })) }]);
    };

    const payload = history.map((m) => ({ role: m.role, content: m.content }));
    const run = async (docId: string) => {
      for await (const ev of streamChat(docId, payload, ctrl.signal)) {
        if (ev.type === "segment") update((m) => m.segments!.push({ text: "", citations: [] }));
        else if (ev.type === "text")
          update((m) => {
            if (!m.segments!.length) m.segments!.push({ text: "", citations: [] });
            m.segments!.at(-1)!.text += ev.text;
            m.content += ev.text;
          });
        else if (ev.type === "citation")
          update((m) => m.segments!.at(-1)?.citations.push({ page: ev.page, endPage: ev.endPage, text: ev.text }));
        else if (ev.type === "error") update((m) => (m.error = ev.message));
      }
    };

    try {
      try {
        await run(d.docId);
      } catch (e) {
        // Server restarted and forgot the document: upload again and retry once.
        if (!(e instanceof DocNotFoundError)) throw e;
        const up = await uploadPdf(d.file);
        setDoc({ ...d, docId: up.docId });
        await run(up.docId);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) update((m) => (m.error = (e as Error).message));
    } finally {
      update((m) => (m.pending = false));
      setBusy(false);
    }
  };

  const onSelAction = async (action: SelAction) => {
    if (!selection) return;
    const { text, page } = selection;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    const quote = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
    if (action === "ask") {
      const q = window.prompt("关于这段文字，你想问什么？");
      if (!q) return;
      ask(`「${short(text)}」\n${q}`, `【当前页】第 ${page} 页\n【选中文本】\n${quote}\n\n${q}`);
      return;
    }
    const { label, prompt } = SEL_PROMPTS[action];
    ask(`${label}：「${short(text)}」`, `【当前页】第 ${page} 页\n【选中文本】\n${quote}\n\n${prompt}`);
  };

  const onQuick = async (kind: "overview" | "page") => {
    if (kind === "overview") {
      ask(
        "全文导读",
        "请给这份文档写一份导读：1) 一句话说清它讲什么；2) 结构/章节脉络；3) 最重要的 3-5 个观点或结论；4) 阅读建议（哪些部分值得细读）。",
      );
    } else {
      const page = currentPage;
      ask(`总结第 ${page} 页`, `【当前页】第 ${page} 页\n\n请总结第 ${page} 页讲了什么，列出要点，并说明它和前后内容的关系。`);
    }
  };

  const onPageCount = useCallback((n: number) => setPageCount(n), []);
  const onCurrentPage = useCallback((n: number) => setCurrentPage(n), []);
  const onSelection = useCallback((s: SelectionInfo | null) => setSelection(s), []);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) openFile(f);
      }}
    >
      <header className="toolbar">
        <span className="brand">AI Reader</span>
        <label className="btn">
          {loading ? "打开中…" : "打开 PDF"}
          <input
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = "";
            }}
          />
        </label>
        {doc && <span className="docname" title={doc.name}>{doc.name}</span>}
        <span className="spacer" />
        {doc && (
          <>
            <span className="muted">
              {currentPage} / {pageCount}
            </span>
            <button onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}>−</button>
            <span className="muted">{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}>+</button>
          </>
        )}
      </header>

      <main className="body">
        <section className="reader">
          {doc ? (
            <PdfViewer
              ref={viewer}
              data={doc.data}
              scale={scale}
              onPageCount={onPageCount}
              onCurrentPage={onCurrentPage}
              onSelection={onSelection}
            />
          ) : (
            <div className="welcome">
              <h1>AI Reader</h1>
              <p>把 PDF 拖到这里，或点左上角"打开 PDF"。</p>
              <p className="muted">AI 会通读整份文档：你可以随时提问、选中文字让它解释或翻译，回答会标出出处页码。</p>
              {loadError && <p className="error">⚠ {loadError}</p>}
            </div>
          )}
          {doc && loadError && <div className="toast error">⚠ {loadError}</div>}
          {dragging && <div className="dropzone">松开以打开 PDF</div>}
        </section>

        <ChatPanel
          messages={messages}
          busy={busy}
          hasDoc={!!doc}
          currentPage={currentPage}
          onSend={(t) => ask(t, `【当前页】第 ${currentPage} 页\n\n${t}`)}
          onQuick={onQuick}
          onStop={() => abortRef.current?.abort()}
          onJump={(p) => viewer.current?.scrollToPage(p)}
          onClear={() => setMessages([])}
        />
      </main>

      {selection && (
        <div
          className="sel-toolbar"
          style={{ left: selection.x, top: Math.max(8, selection.y - 44) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {(Object.keys(SEL_PROMPTS) as (keyof typeof SEL_PROMPTS)[]).map((k) => (
            <button key={k} onClick={() => onSelAction(k)} disabled={busy}>
              {SEL_PROMPTS[k].label}
            </button>
          ))}
          <button onClick={() => onSelAction("ask")} disabled={busy}>
            提问…
          </button>
        </div>
      )}
    </div>
  );
}

function short(s: string, n = 60) {
  const t = s.replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n) + "…" : t;
}
