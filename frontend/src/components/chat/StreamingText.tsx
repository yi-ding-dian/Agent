import { MarkdownRenderer } from '../common/MarkdownRenderer';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export function StreamingText({ content, isStreaming }: StreamingTextProps) {
  if (!content && !isStreaming) return null;

  return (
    <div className="streaming-text">
      {content ? (
        <MarkdownRenderer content={content} isStreaming={isStreaming} />
      ) : (
        <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>思考中...</span>
      )}
      {isStreaming && <span className="streaming-cursor" />}
    </div>
  );
}
