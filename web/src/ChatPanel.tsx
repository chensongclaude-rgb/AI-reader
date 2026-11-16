import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage, Segment } from "./api";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  hasDoc: boolean;
  currentPage: number;
  onSend(text: string): void;
  onQuick(kind: "overview" | "page"): void;
  onStop(): void;
  onJump(page: number): void;
  onClear(): void;
}

export default function ChatPanel(p: Props) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [p.messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || p.busy || !p.hasDoc) return;
    p.onSend(text);
    setInput("");
  };

  return (
    <aside className="chat">
      <header className="chat-head">
        <strong>AI 助手</strong>
        {p.messages.length > 0 && (
          <button className="link" onClick={p.onClear} disabled={p.busy}>
            清空对话
          </button>
        )}
      </header>

      <div className="chat-list" ref={listRef}>
        {p.messages.length === 0 && (
          <div className="empty">
            {p.hasDoc ? (
              <>
                <p>问我任何关于这份文档的问题，或者：</p>
                <ul>
                  <li>在左边选中一段文字，点"解释 / 翻译 / 总结"</li>
                  <li>用下面的按钮一键生成导读、总结当前页</li>
                </ul>
                <p className="muted">回答里的 <span className="cite">p.3</span> 标记可以点击，跳回原文。</p>
              </>
            ) : (
              <p>先打开一个 PDF。</p>
            )}
          </div>
        )}
        {p.messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "user" ? (
              <div className="bubble">{m.display}</div>
            ) : (
              <div className="answer">
                {m.segments && <Answer segments={m.segments} onJump={p.onJump} />}
                {m.pending && !m.segments?.some((s) => s.text) && <div className="thinking">正在阅读文档…</div>}
                {m.error && <div className="error">⚠ {m.error}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="quick">
        <button disabled={!p.hasDoc || p.busy} onClick={() => p.onQuick("overview")}>
          全文导读
        </button>
        <button disabled={!p.hasDoc || p.busy} onClick={() => p.onQuick("page")}>
          总结第 {p.currentPage} 页
        </button>
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder={p.hasDoc ? "提问…（Enter 发送，Shift+Enter 换行）" : "先打开一个 PDF"}
          disabled={!p.hasDoc}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {p.busy ? (
          <button onClick={p.onStop}>停止</button>
        ) : (
          <button className="primary" onClick={submit} disabled={!input.trim() || !p.hasDoc}>
            发送
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * Renders an answer. Text blocks are concatenated into one Markdown string,
 * and each block that carries citations gets a clickable page marker appended.
 */
function Answer({ segments, onJump }: { segments: Segment[]; onJump(page: number): void }) {
  let md = "";
  for (const seg of segments) {
    md += seg.text;
    const pages = [...new Set(seg.citations.map((c) => c.page))];
    for (const pg of pages) md += ` [p.${pg}](#page-${pg})`;
  }
  return (
    <div className="md">
      <Markdown
        components={{
          a({ href, children }) {
            const m = href?.match(/^#page-(\d+)$/);
            if (m) {
              const page = Number(m[1]);
              const quote = segments
                .flatMap((s) => s.citations)
                .filter((c) => c.page === page)
                .map((c) => c.text.trim())
                .join("\n…\n");
              return (
                <button className="cite" title={quote} onClick={() => onJump(page)}>
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {md}
      </Markdown>
    </div>
  );
}
