import { useState, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import hljs from 'highlight.js';

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  const lang = language || 'text';
  const validLang = hljs.getLanguage(lang) ? lang : 'text';
  const trimmedCode = code.replace(/\n$/, '');
  const lines = trimmedCode.split('\n');
  const isHtml = ['html', 'htm', 'svg'].includes(lang);

  const highlighted = useMemo(() => {
    try {
      return hljs.highlight(trimmedCode, { language: validLang }).value;
    } catch {
      return hljs.highlightAuto(trimmedCode).value;
    }
  }, [trimmedCode, validLang]);

  const lineNumbersHtml = useMemo(() => {
    let html = '';
    for (let i = 1; i <= lines.length; i++) {
      html += `${i}`;
      if (i < lines.length) html += '\n';
    }
    return html;
  }, [lines.length]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [code]);

  // 同步行号滚动：pre 滚动时行号跟随
  const handlePreScroll = useCallback(() => {
    const pre = preRef.current;
    const lineNumbers = lineNumbersRef.current;
    if (pre && lineNumbers) {
      lineNumbers.scrollTop = pre.scrollTop;
    }
  }, []);

  // 挂载后滚动到底部
  useLayoutEffect(() => {
    const pre = preRef.current;
    const lineNumbers = lineNumbersRef.current;
    if (pre) {
      pre.scrollTop = pre.scrollHeight;
      if (lineNumbers) lineNumbers.scrollTop = lineNumbers.scrollHeight;
    }
  }, [code]);

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">{lang}</span>
        <div className="code-block-header-actions">
          {isHtml && (
            <button className="code-block-preview-btn" onClick={() => {
              const iframe = document.getElementById('previewIframe') as HTMLIFrameElement;
              if (iframe) {
                iframe.srcdoc = code;
                document.getElementById('previewOverlay')?.classList.add('active');
              }
            }}>
              预览
            </button>
          )}
          <button
            className={`code-block-copy-btn${copied ? ' copied' : ''}`}
            onClick={handleCopy}
          >
            {copied ? '已复制!' : '复制'}
          </button>
        </div>
      </div>
      <div className="code-block-content">
        <div className="code-block-line-numbers" ref={lineNumbersRef}>
          {lineNumbersHtml}
        </div>
        <pre ref={preRef} onScroll={handlePreScroll}>
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      </div>
    </div>
  );
}
