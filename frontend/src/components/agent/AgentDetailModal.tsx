import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentInfo } from '../../types/chat';
import { MarkdownRenderer } from '../common/MarkdownRenderer';

interface AgentDetailModalProps {
  agent: AgentInfo;
  /** 列表序号（从 1 开始） */
  index: number;
  onClose: () => void;
}

/** 子代理工具卡片（tool_start 开启，tool_end 闭合） */
interface ToolCard {
  key: string;
  toolName: string;
  args: unknown;
  status: 'running' | 'completed' | 'error';
  result?: unknown;
  /** 开始时间戳（tool_start 事件携带，格式化 HH:MM:SS.mmm） */
  ts?: number;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  execute_command: '执行命令',
  search_web: '搜索网络',
  run_python: '运行Python',
  subagent: '子代理',
};

/** 参数/结果摘要：字符串原样，对象 JSON 化（最多 400 字） */
function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '';
  const json = JSON.stringify(payload);
  return json.length > 400 ? json.slice(0, 400) + '…' : json;
}

/** 时间戳格式：HH:MM:SS.mmm（与主界面 tool-group-time 一致） */
function formatEventTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return (
    d.toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

/** 单行参数摘要：字符串原样，对象 JSON 化，截断 ~60 字 */
function summarizeArgsInline(args: unknown): string {
  if (args === undefined || args === null) return '';
  const raw = typeof args === 'string' ? args : formatPayload(args);
  return raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
}

/** 事件流 → 展示结构：工具卡片（配对的 start/end）+ 文本增量 + 思考增量 + 结束标记 */
function buildEventView(events: AgentInfo['events']) {
  const toolCards: ToolCard[] = [];
  const stack: ToolCard[] = [];
  let textBuffer = '';
  let thinkingBuffer = '';
  let finished = false;
  for (const evt of events) {
    switch (evt.kind) {
      case 'tool_start': {
        const card: ToolCard = {
          key: `${evt.toolName || 'tool'}-${toolCards.length}`,
          toolName: evt.toolName || '',
          args: evt.args,
          status: 'running',
          ts: evt.ts,
        };
        toolCards.push(card);
        stack.push(card);
        break;
      }
      case 'tool_end': {
        const card = stack.pop();
        if (card) {
          card.status = evt.isError ? 'error' : 'completed';
          card.result = evt.result;
        }
        break;
      }
      case 'text_delta':
        if (evt.text) textBuffer += evt.text;
        break;
      case 'thinking_delta':
        if (evt.text) thinkingBuffer += evt.text;
        break;
      case 'agent_end':
        finished = true;
        break;
    }
  }
  return { toolCards, textBuffer, thinkingBuffer, finished };
}

export function AgentDetailModal({ agent, index, onClose }: AgentDetailModalProps) {
  // running 时每秒刷新一次"进行中时长"，结束或关闭后停表
  const [, setTick] = useState(0);
  useEffect(() => {
    if (agent.status !== 'running') return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [agent.status]);

  const { toolCards, textBuffer, thinkingBuffer, finished } = useMemo(
    () => buildEventView(agent.events),
    [agent.events],
  );

  // 思考块折叠状态（running 时自动展开，与主对话 thinking 行为一致）
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // 工具调用分组折叠状态：默认折叠，点击分组标题栏展开（对齐主界面 ToolCallGroup）
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // 工具日志行折叠状态：默认全部折叠，点击行展开完整参数/结果
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const toggleCard = (key: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const thinkingOpen = thinkingExpanded || (agent.status === 'running' && !!thinkingBuffer);

  // 工具调用统计（分组标题栏徽章：执行中 / 成功 / 失败）
  const completedCount = toolCards.filter((c) => c.status === 'completed').length;
  const errorCount = toolCards.filter((c) => c.status === 'error').length;
  const runningCount = toolCards.filter((c) => c.status === 'running').length;

  const durationSec = agent.endedAt
    ? Math.max(0, Math.round((agent.endedAt - agent.startedAt) / 1000))
    : Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000));

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 挂到 document.body：父级 .question-panel 有 backdrop-filter + overflow，
  // 会劫持 fixed 定位并裁剪弹窗，portal 到 body 规避
  return createPortal(
    <div className="agent-detail-overlay" onClick={onClose}>
      <div
        className="agent-detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Agent ${index} 详情`}
      >
        <div className="agent-detail-header">
          <span className="agent-detail-title">Agent #{index}</span>
          <span className={`agent-status-badge ${agent.status}`}>
            {agent.status === 'running'
              ? '执行中'
              : agent.status === 'completed'
                ? '完成'
                : '失败'}
          </span>
          <span className="agent-detail-duration">
            {agent.status === 'running' ? '进行中 ' : '用时 '}
            {durationSec}s
          </span>
          <button type="button" className="agent-detail-close" onClick={onClose}>
            &#10005;
          </button>
        </div>
        <div className="agent-detail-task">任务：{agent.task || '(未提供任务描述)'}</div>

        <div className="agent-detail-body">
          {toolCards.length === 0 && !textBuffer && !thinkingBuffer && (
            <div className="agent-detail-empty">暂无过程事件</div>
          )}

          {/* 思考过程（折叠块，样式与主对话 thinking-block 一致：米黄背景/可展开） */}
          {thinkingBuffer && (
            <div className="thinking-block agent-thinking-block">
              <div
                className="thinking-header"
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
              >
                <span className="thinking-chevron">{thinkingOpen ? '▼' : '▶'}</span>
                <span className="thinking-label">
                  {agent.status === 'running' && !textBuffer ? '思考中...' : '思考过程'}
                </span>
              </div>
              {thinkingOpen && <div className="thinking-content">{thinkingBuffer}</div>}
            </div>
          )}

          {/* 回复内容：textBuffer（子代理流式回复）用 MarkdownRenderer 渲染，
              与主界面消息内容一致（标题/表格/代码高亮/列表），容器样式见
              .agent-detail-modal .markdown-content（对齐 .message-bubble 规则） */}
          {textBuffer && (
            <div className="agent-event-text">
              <MarkdownRenderer content={textBuffer} isStreaming={agent.status === 'running'} />
              {/* 流式光标：运行中且已有文本增量时提示生成中（放在 Markdown 容器末尾） */}
              {agent.status === 'running' && <span className="agent-event-streaming">▍生成中…</span>}
            </div>
          )}

          {/* 工具调用折叠组：形态对齐主界面 ToolCallGroup（标题栏 + 徽章 + ▸箭头，默认折叠）。
              展开后为紧凑日志行列表（状态图标+时间戳+工具名+参数摘要，行点击展开完整参数/结果） */}
          {toolCards.length > 0 && (
            <div className="tool-call-group">
              <div
                className="tool-call-group-header"
                onClick={() => setToolsExpanded(!toolsExpanded)}
                role="button"
                tabIndex={0}
                aria-expanded={toolsExpanded}
              >
                <span className="tool-call-group-title">&#9881; 工具调用 ({toolCards.length})</span>
                {runningCount > 0 && (
                  <span className="tool-group-badge running">{runningCount} 执行中</span>
                )}
                {completedCount > 0 && (
                  <span className="tool-group-badge success">{completedCount} 成功</span>
                )}
                {errorCount > 0 && (
                  <span className="tool-group-badge error">{errorCount} 失败</span>
                )}
                <span className={`tool-group-chevron${toolsExpanded ? ' expanded' : ''}`}>
                  &#9654;
                </span>
              </div>
              {toolsExpanded && (
                <div className="tool-call-group-body">
                  {toolCards.map((card) => {
                    const cardOpen = expandedCards.has(card.key);
                    return (
                      <div key={card.key} className={`agent-event-card ${card.status}`}>
                        {/* 点击整行展开/收起（默认折叠，与主界面工具调用一致） */}
                        <div
                          className="agent-event-tool-row"
                          onClick={() => toggleCard(card.key)}
                          role="button"
                          tabIndex={0}
                        >
                          <span className="agent-event-toggle">{cardOpen ? '▾' : '▸'}</span>
                          <span className="agent-event-status">
                            {card.status === 'running' ? (
                              <span className="agent-event-spinner" />
                            ) : card.status === 'completed' ? (
                              <span className="agent-event-ok">&#10003;</span>
                            ) : (
                              <span className="agent-event-err">&#10007;</span>
                            )}
                          </span>
                          <span className="agent-event-time">{formatEventTime(card.ts)}</span>
                          <span className="agent-event-tool-name">
                            {TOOL_LABELS[card.toolName] || card.toolName || '工具'}
                          </span>
                          <span className="agent-event-args-inline">
                            {summarizeArgsInline(card.args)}
                          </span>
                          {card.status === 'running' && (
                            <span className={`agent-event-state ${card.status}`}>执行中</span>
                          )}
                        </div>
                        {cardOpen && (
                          <>
                            {formatPayload(card.args) && (
                              <pre className="agent-event-args">{formatPayload(card.args)}</pre>
                            )}
                            {card.result !== undefined && formatPayload(card.result) && (
                              <pre
                                className={`agent-event-result${card.status === 'error' ? ' error' : ''}`}
                              >
                                {formatPayload(card.result)}
                              </pre>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {finished && (
            <div className="agent-event-finish">
              {agent.status === 'error' ? '子代理执行失败' : '子代理执行完毕'}
            </div>
          )}

          {agent.summary && (
            <div className="agent-event-summary">
              <div className="agent-event-summary-label">最终摘要</div>
              <div className="agent-event-summary-text">{agent.summary}</div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
