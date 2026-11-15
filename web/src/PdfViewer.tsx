import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfViewerHandle {
  scrollToPage(page: number): void;
  getPageText(page: number): Promise<string>;
}

export interface SelectionInfo {
  text: string;
  page: number;
  /** Position for the floating toolbar, relative to the viewport. */
  x: number;
  y: number;
}

interface Props {
  data: ArrayBuffer;
  scale: number;
  onPageCount(n: number): void;
  onCurrentPage(n: number): void;
  onSelection(sel: SelectionInfo | null): void;
}

interface PageSize {
  width: number;
  height: number;
}

const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { data, scale, onPageCount, onCurrentPage, onSelection },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const textCache = useRef(new Map<number, string>());

  // Load document
  useEffect(() => {
    let cancelled = false;
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    const task = pdfjs.getDocument({ data: data.slice(0) });
    task.promise.then(async (pdf) => {
      if (cancelled) return;
      const s: PageSize[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        s.push({ width: vp.width, height: vp.height });
      }
      if (cancelled) return;
      textCache.current.clear();
      setSizes(s);
      setDoc(pdf);
      onPageCount(pdf.numPages);
    });
    return () => {
      cancelled = true;
      task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Lazy render pages near the viewport; re-render on zoom.
  useEffect(() => {
    if (!doc) return;
    const rendered = new Set<number>();
    const tasks: { cancel(): void }[] = [];

    const render = async (index: number) => {
      if (rendered.has(index)) return;
      rendered.add(index);
      const el = pageEls.current[index];
      if (!el) return;
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";

      el.replaceChildren(canvas, textDiv);
      const renderTask = page.render({
        canvas,
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      tasks.push(renderTask);
      const textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });
      tasks.push(textLayer);
      await Promise.all([renderTask.promise, textLayer.render()]).catch(() => {});
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) render(Number((e.target as HTMLElement).dataset.index));
        }
      },
      { root: containerRef.current, rootMargin: "800px 0px" },
    );
    pageEls.current.forEach((el) => el && io.observe(el));
    return () => {
      io.disconnect();
      tasks.forEach((t) => t.cancel());
      pageEls.current.forEach((el) => el?.replaceChildren());
    };
  }, [doc, scale, sizes]);

  // Track the current page while scrolling.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !sizes.length) return;
    const onScroll = () => {
      const mid = root.scrollTop + root.clientHeight / 3;
      let current = 1;
      pageEls.current.forEach((el, i) => {
        if (el && el.offsetTop <= mid) current = i + 1;
      });
      onCurrentPage(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [sizes, scale, onCurrentPage]);

  // Report text selections inside pages.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onUp = () => {
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || !text || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
          onSelection(null);
          return;
        }
        const pageEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)
          ?.closest<HTMLElement>(".page");
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        onSelection({
          text,
          page: pageEl ? Number(pageEl.dataset.index) + 1 : 1,
          x: rect.left + rect.width / 2,
          y: rect.top,
        });
      }, 0);
    };
    root.addEventListener("mouseup", onUp);
    return () => root.removeEventListener("mouseup", onUp);
  }, [onSelection]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage(page) {
        const el = pageEls.current[page - 1];
        const root = containerRef.current;
        if (el && root) root.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
        el?.classList.add("flash");
        setTimeout(() => el?.classList.remove("flash"), 1200);
      },
      async getPageText(page) {
        if (!doc) return "";
        const cached = textCache.current.get(page);
        if (cached !== undefined) return cached;
        const content = await (await doc.getPage(page)).getTextContent();
        const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
        textCache.current.set(page, text);
        return text;
      },
    }),
    [doc],
  );

  return (
    <div className="viewer" ref={containerRef}>
      {sizes.map((s, i) => (
        <div
          key={i}
          ref={(el) => {
            pageEls.current[i] = el;
          }}
          className="page"
          data-index={i}
          style={
            {
              width: s.width * scale,
              height: s.height * scale,
              "--scale-factor": scale,
              "--total-scale-factor": scale,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
});

export default PdfViewer;
