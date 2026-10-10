import type { ToolCallInfo } from '../../types/chat';
import { CodeBlock } from './CodeBlock';

interface ToolExecutionViewProps {
  toolCall: ToolCallInfo;
}

export function ToolExecutionView({ toolCall }: ToolExecutionViewProps) {
  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{
        padding: '8px 12px',
        backgroundColor: 'var(--bg-primary)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        marginBottom: 8,
        fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          工具: {toolCall.toolName}
          <span style={{
            marginLeft: 8,
            fontSize: 11,
            color: toolCall.status === 'completed' ? 'var(--success)' : toolCall.status === 'error' ? 'var(--danger)' : 'var(--warning)',
          }}>
            ({toolCall.status})
          </span>
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>输入:</div>
        <CodeBlock code={JSON.stringify(toolCall.args, null, 2)} language="json" />
        {toolCall.result !== undefined && (
          <>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4, marginTop: 8 }}>输出:</div>
            <CodeBlock
              code={typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
              language="json"
            />
          </>
        )}
      </div>
    </div>
  );
}
