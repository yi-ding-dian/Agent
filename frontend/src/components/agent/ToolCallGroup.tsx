import { useState } from 'react';
import type { ToolCallInfo } from '../../types/chat';

interface ToolCallGroupProps {
  toolCalls: ToolCallInfo[];
}

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatArgs(tc: ToolCallInfo): string {
  const a = tc.args || {};
  switch (tc.toolName) {
    case 'read_file':
      return a.path || a.filePath || '';
    case 'write_file':
      return a.path || a.filePath || '';
    case 'execute_command':
      return a.command || '';
    case 'search_web':
      return a.query || '';
    case 'run_python': {
      const code: string = a.code || '';
      return code.length > 60 ? code.slice(0, 60) + '...' : code;
    }
    default:
      return JSON.stringify(a);
  }
}

function StatusIcon({ status }: { status: ToolCallInfo['status'] }) {
  switch (status) {
    case 'running':
      return <span className="tool-group-status running" />;
    case 'completed':
      return <span className="tool-group-status completed">&#10003;</span>;
    case 'error':
      return <span className="tool-group-status error">&#10007;</span>;
    default:
      return <span className="tool-group-status pending" />;
  }
}

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  execute_command: '执行命令',
  search_web: '搜索网络',
  run_python: '运行Python',
};

export function ToolCallGroup({ toolCalls }: ToolCallGroupProps) {
  // 默认折叠（用户要求：工具调用不自动展开，点击才展开）
  const [expanded, setExpanded] = useState(false);
  const running = toolCalls.filter((t) => t.status === 'running').length;
  const errors = toolCalls.filter((t) => t.status === 'error').length;

  return (
    <div className="tool-call-group">
      <div className="tool-call-group-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-group-title">
          &#9881; 工具调用 ({toolCalls.length})
        </span>
        {running > 0 && <span className="tool-group-badge running">{running} 执行中</span>}
        {errors > 0 && <span className="tool-group-badge error">{errors} 失败</span>}
        <span className={`tool-group-chevron${expanded ? ' expanded' : ''}`}>&#9654;</span>
      </div>
      {expanded && (
        <div className="tool-call-group-body">
          {toolCalls.map((tc) => (
            <div key={tc.id} className={`tool-group-item ${tc.status}`} data-tool-call-id={tc.id}>
              <StatusIcon status={tc.status} />
              <span className="tool-group-time">{formatTime(tc.startTime)}</span>
              <span className="tool-group-action">{TOOL_LABELS[tc.toolName] || tc.toolName}</span>
              <span className="tool-group-args">{formatArgs(tc)}</span>
              {tc.status === 'error' && tc.errorMessage && (
                <div className="tool-group-error-msg">{tc.errorMessage}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
