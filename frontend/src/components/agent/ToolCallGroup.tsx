import { useState } from 'react';
import type { ToolCallInfo } from '../../types/chat';
import { TOOL_LABELS, formatToolArgs, formatToolPayload, formatToolTime } from '../../utils/tool-display';

interface ToolCallGroupProps {
  toolCalls: ToolCallInfo[];
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

/**
 * 工具调用折叠组（主 Agent 消息区与子 Agent 详情弹窗共用）
 *
 * 层叠两级展开：组头点击展开列表；列表内每行点击展开该条工具的完整参数与返回结果。
 * 格式化与标签统一走 utils/tool-display，避免主/子两侧各维护一份导致行为不一致。
 */
export function ToolCallGroup({ toolCalls }: ToolCallGroupProps) {
  // 默认折叠（用户要求：工具调用不自动展开，点击才展开）
  const [expanded, setExpanded] = useState(false);
  // 单条工具卡片的展开态（点行查看完整 args / result）
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const running = toolCalls.filter((t) => t.status === 'running').length;
  const errors = toolCalls.filter((t) => t.status === 'error').length;

  const toggleRow = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
          {toolCalls.map((tc) => {
            const argsText = formatToolArgs(tc.toolName, tc.args);
            const open = openIds.has(tc.id);
            const detailArgs = formatToolPayload(tc.args);
            const detailResult = tc.result === undefined ? '' : formatToolPayload(tc.result);
            return (
              <div
                key={tc.id}
                className={`tool-group-item ${tc.status}`}
                data-tool-call-id={tc.id}
                onClick={() => toggleRow(tc.id)}
              >
                <span className={`tool-group-toggle${open ? ' open' : ''}`}>&#9654;</span>
                <StatusIcon status={tc.status} />
                <span className="tool-group-time">{formatToolTime(tc.startTime)}</span>
                <span className="tool-group-action">{TOOL_LABELS[tc.toolName] || tc.toolName}</span>
                <span className="tool-group-args" title={argsText}>{argsText}</span>
                {tc.status === 'error' && tc.errorMessage && (
                  <div className="tool-group-error-msg">{tc.errorMessage}</div>
                )}
                {open && (
                  <div className="tool-group-detail">
                    {detailArgs && <pre className="tool-group-pre">{detailArgs}</pre>}
                    {detailResult && <pre className="tool-group-pre result">{detailResult}</pre>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
