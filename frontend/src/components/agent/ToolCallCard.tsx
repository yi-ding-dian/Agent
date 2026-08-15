import { useState } from 'react';
import type { ToolCallInfo } from '../../types/chat';

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
}

function StatusIcon({ status }: { status: ToolCallInfo['status'] }) {
  switch (status) {
    case 'running':
      return <div className="tool-call-status-icon running" />;
    case 'completed':
      return <div className="tool-call-status-icon completed">&#10003;</div>;
    case 'error':
      return <div className="tool-call-status-icon error">&#10007;</div>;
    case 'pending':
    default:
      return <div className="tool-call-status-icon" style={{ border: '2px solid var(--border)' }} />;
  }
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tool-call-card">
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <StatusIcon status={toolCall.status} />
        <span className="tool-call-name">{toolCall.toolName}</span>
        <span className={`tool-call-chevron${expanded ? ' expanded' : ''}`}>&#9654;</span>
      </div>
      {expanded && (
        <div className="tool-call-body">
          <div className="tool-call-section">
            <div className="tool-call-section-title">参数</div>
            <div className="tool-call-section-content">
              {JSON.stringify(toolCall.args, null, 2)}
            </div>
          </div>
          {toolCall.result !== undefined && (
            <div className="tool-call-section">
              <div className="tool-call-section-title">结果</div>
              <div className="tool-call-section-content">
                {typeof toolCall.result === 'string'
                  ? toolCall.result
                  : JSON.stringify(toolCall.result, null, 2)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
