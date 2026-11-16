# AI Reader

和 AI 深度绑定的阅读器。第一版支持 PDF。

## 能做什么

- **打开 PDF**：点"打开 PDF"或直接把文件拖进窗口，支持缩放、文字选择。
- **AI 通读全文**：整份 PDF（包括图表、版式）会发给 Claude，所以它能回答关于全文的问题，不只是当前这一页。
- **选中即问**：在 PDF 里选中一段文字，会弹出小工具栏：解释 / 翻译 / 总结 / 提问。
- **一键导读**：全文导读、总结当前页。
- **出处可点**：AI 回答中引用原文的地方会带 `p.N` 标记，点一下跳回那一页（鼠标悬停可以看到被引用的原文）。
- **知道你在看哪**：每次提问都会自动带上你当前所在的页码，AI 会优先围绕这一页回答。

## 运行

需要 Node.js 20+ 和一个 Anthropic API Key。

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev        # 开发模式：打开 http://localhost:5173
```

生产模式：

```bash
npm run build
npm start          # 打开 http://localhost:8787
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | 必填 |
| `AI_READER_MODEL` | `claude-opus-5-5` | 使用的模型 |
| `PORT` | `8787` | 后端端口 |

## 结构

```
server/index.ts     后端：保存上传的 PDF，调用 Claude，流式返回回答和页码引用
web/src/App.tsx     页面骨架：打开文件、选中文字的工具栏、发起提问
web/src/PdfViewer.tsx  PDF 渲染（pdf.js）：按需渲染页面、文字层、当前页跟踪、跳页
web/src/ChatPanel.tsx  右侧对话面板：Markdown 回答、可点击的页码引用
web/src/api.ts      前端调用后端的接口
```

## 实现要点

- API Key 只在后端，浏览器拿不到。
- PDF 以 `document` 块发给 Claude，开启了 citations（回答带页码出处）和 prompt caching（同一份文档连续提问时，PDF 部分走缓存，又快又便宜）。
- 开启了服务端 fallback：主模型拒答时，API 会自动换一个模型重试。
- 限制：单个 PDF 最大 32MB / 600 页（Claude API 的上限）；上传的文档存在后端内存里，重启后前端会自动重新上传。

## 下一步可以做

- 阅读记录与对话保存（本地数据库）
- 高亮 / 批注，并让 AI 基于你的批注回答
- 超大 PDF：按章节切分 + 检索
- 支持 EPUB、网页、Word 等更多格式
