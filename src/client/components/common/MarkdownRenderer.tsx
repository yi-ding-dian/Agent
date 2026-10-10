import { useMemo, useRef, useLayoutEffect } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { openImageOverlay } from '../../utils/image-overlay';
import { scheduleImageHoverPreview, cancelImageHoverPreview } from '../../utils/image-hover-preview';

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
        window.dispatchEvent(new Event('myagent:preview-open'));
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

/**
 * 正文图片点击 → 全屏预览。
 * 内容经 dangerouslySetInnerHTML 注入，无法逐节点绑定，故用事件委托。
 */
function handleContentClick(e: ReactMouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  if (target.tagName !== 'IMG') return;
  const img = target as HTMLImageElement;
  // 图片可能被 <a> 包裹（如 [![alt](img)](link)）：阻止其导航，只开浮层
  e.preventDefault();
  // 用浏览器解析后的绝对地址，避免浮层再按当前源解析一次（知识库图为相对路径）
  openImageOverlay(img.currentSrc || img.src);
}

/** 悬停在图片链接上 → 延迟后弹预览（时长见 image-hover-preview 的 HOVER_DELAY_MS）；移出则取消。事件委托同 handleContentClick */
function handleContentMouseOver(e: ReactMouseEvent<HTMLDivElement>): void {
  const anchor = (e.target as HTMLElement).closest('a');
  if (anchor) scheduleImageHoverPreview(anchor.getAttribute('href') ?? '');
  else cancelImageHoverPreview();
}

function handleContentMouseOut(e: ReactMouseEvent<HTMLDivElement>): void {
  const anchor = (e.target as HTMLElement).closest('a');
  if (!anchor) return;
  // 在链接内部移到子元素（如 <strong>）不算移出
  const to = e.relatedTarget as Node | null;
  if (to && anchor.contains(to)) return;
  cancelImageHoverPreview();
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

    // 正文外链一律新标签页打开：否则点击后当前会话页会被目标页面顶掉
    // （图片类链接最直观：浏览器直接把整个标签页换成那张图）
    // 相对路径（如知识库 /api/ext/...）与锚点不加 target，保持原生行为
    renderer.link = function ({ href, title, tokens }: { href: string; title?: string | null; tokens: any[] }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${attr(title)}"` : '';
      const blank = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${attr(href)}"${titleAttr}${blank}>${text}</a>`;
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
      onClick={handleContentClick}
      onMouseOver={handleContentMouseOver}
      onMouseOut={handleContentMouseOut}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
