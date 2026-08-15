import { useMemo, useRef, useLayoutEffect } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js';

const renderer = new marked.Renderer();

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lineNums(count: number): string {
  let h = '';
  for (let i = 1; i <= count; i++) { h += i; if (i < count) h += '\n'; }
  return h;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

function buildCodeBlock(
  trimmed: string,
  language: string,
  validLang: string,
  lines: string[],
  total: number,
  isHtml: boolean,
  useHighlight: boolean,
) {
  let codeHtml: string;
  if (useHighlight) {
    try { codeHtml = hljs.highlight(trimmed, { language: validLang }).value; }
    catch { codeHtml = hljs.highlightAuto(trimmed).value; }
  } else {
    codeHtml = escapeHtml(trimmed);
  }

  const nums = lineNums(total);

  return `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-block-lang">${language}</span>
    <div class="code-block-header-actions">
      ${isHtml ? `<button class="code-block-preview-btn" data-html="${attr(trimmed)}" onclick="void function(btn){
        var iframe=document.getElementById('previewIframe');
        iframe.srcdoc=btn.getAttribute('data-html');
        document.getElementById('previewOverlay').classList.add('active');
      }(this)">预览</button>` : ''}
      <button class="code-block-copy-btn" onclick="void function(btn){
        var code=btn.closest('.code-block-wrapper').querySelector('code').textContent;
        navigator.clipboard.writeText(code).then(function(){btn.textContent='已复制!';btn.classList.add('copied');setTimeout(function(){btn.textContent='复制';btn.classList.remove('copied');},2000);});
      }(this)">复制</button>
    </div>
  </div>
  <div class="code-block-content">
    <div class="code-block-line-numbers">${nums}</div>
    <pre><code class="hljs">${codeHtml}</code></pre>
  </div>
</div>`;
}

marked.setOptions({
  renderer,
  breaks: true,
  gfm: true,
});

/** 同步代码块行号滚动：pre 滚动时行号跟随 */
function syncCodeBlockScroll(container: HTMLElement) {
  container.querySelectorAll('.code-block-wrapper').forEach((wrapper) => {
    const lineNumbers = wrapper.querySelector<HTMLElement>('.code-block-line-numbers');
    const pre = wrapper.querySelector('pre');
    if (!lineNumbers || !pre) return;
    (pre as any)._codeBlockScrollSynced = true;
    pre.onscroll = () => { lineNumbers.scrollTop = pre.scrollTop; };
  });
}

/** 判断当前内容是否正在代码块内部（代码块未闭合） */
function isInsideCodeBlock(content: string): boolean {
  const lines = content.split('\n');
  let inside = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inside = !inside;
    }
  }
  return inside;
}

export function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 在渲染阶段（DOM 更新前）保存每个代码块的滚动位置，用索引对应
  const savedScrollPositions = useRef<number[]>([]);

  // 渲染阶段：提取旧 DOM 的滚动位置，此时 containerRef 还是旧 DOM
  if (containerRef.current) {
    savedScrollPositions.current = [];
    containerRef.current.querySelectorAll('.code-block-wrapper pre').forEach((pre) => {
      savedScrollPositions.current.push(pre.scrollTop);
    });
  }

  const html = useMemo(() => {
    renderer.code = function ({ text, lang }: { text: string; lang?: string; }) {
      const language = lang || 'text';
      const validLang = hljs.getLanguage(language) ? language : 'text';
      const trimmed = text.replace(/\n$/, '');
      const lines = trimmed.split('\n');
      const total = lines.length;
      const isHtml = ['html', 'htm', 'svg'].includes(language);
      return buildCodeBlock(trimmed, language, validLang, lines, total, isHtml, true);
    };

    try {
      return marked.parse(content) as string;
    } catch {
      return `<p>${content}</p>`;
    }
  }, [content]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    syncCodeBlockScroll(container);

    // 恢复之前保存的滚动位置（按索引匹配）
    container.querySelectorAll('.code-block-wrapper pre').forEach((pre, idx) => {
      const saved = savedScrollPositions.current[idx];
      if (saved !== undefined && saved > 0) {
        pre.scrollTop = saved;
      }
    });

    // 仅在正在流式生成代码块内部时，自动把最后一个代码块滚到底部
    if (isStreaming && isInsideCodeBlock(content)) {
      const wrappers = container.querySelectorAll('.code-block-wrapper');
      const last = wrappers[wrappers.length - 1];
      if (last) {
        const pre = last.querySelector('pre');
        const lineNums = last.querySelector<HTMLElement>('.code-block-line-numbers');
        if (pre) {
          pre.scrollTop = pre.scrollHeight;
          if (lineNums) lineNums.scrollTop = lineNums.scrollHeight;
        }
      }
    }
  }, [html, isStreaming, content]);

  return (
    <div
      ref={containerRef}
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
