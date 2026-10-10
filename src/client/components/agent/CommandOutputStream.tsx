import { useRef, useEffect } from 'react';

interface Props {
  output: string;
  isStreaming?: boolean;
}

/**
 * 命令执行实时输出流显示
 * 在工具卡片内实时追加显示 stdout/stderr 输出
 */
export function CommandOutputStream({ output, isStreaming }: Props) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current && isStreaming) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output, isStreaming]);

  if (!output) return null;

  return (
    <div className="cmd-output-container">
      <pre ref={preRef} className="cmd-output">
        <code>{output}</code>
      </pre>
      {isStreaming && <span className="cmd-streaming-indicator">● 执行中...</span>}
    </div>
  );
}
