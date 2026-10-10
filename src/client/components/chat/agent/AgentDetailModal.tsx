import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentInfo, ToolCallInfo } from '../../../types/chat';
import { MarkdownRenderer } from '../../common/MarkdownRenderer';
import { ResizableModal } from '../../common/ResizableModal';
import { ToolCallGroup } from './ToolCallGroup';
import { useChatStore } from '../../../store/chat-store';

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

/* 工具名标签、参数/时间格式化统一走 utils/tool-display ——
   此前本文件各写一份（TOOL_LABELS / formatPayload / formatEventTime / summarizeArgsInline），
   与主界面 ToolCallGroup 重复，导致主/子两侧行为不一致、每次调整都要改两处。 */

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
  const stopSubAgent = useChatStore((s) => s.stopSubAgent);
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

  // ToolCard → ToolCallInfo 映射，使子 Agent 直接复用主界面的 ToolCallGroup。
  // 两侧字段本就同构，仅两处命名不同：key→id、ts→startTime。
  const toolCallsForGroup: ToolCallInfo[] = useMemo(
    () =>
      toolCards.map((c) => ({
        id: c.key,
        toolName: c.toolName,
        args: c.args,
        status: c.status,
        result: c.result,
        startTime: c.ts,
      })),
    [toolCards],
  );

  // 思考块折叠状态（running 时自动展开，与主对话 thinking 行为一致）
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const thinkingOpen = thinkingExpanded || (agent.status === 'running' && !!thinkingBuffer);

  const bodyRef = useRef<HTMLDivElement>(null);
  /** 思考块内部滚动容器（.thinking-content 有 max-height，是独立滚动区） */
  const thinkingRef = useRef<HTMLDivElement>(null);

  /**
   * 用户是否手动滚离了底部。
   *
   * 必须按「用户主动滚动」判断，不能用「当前位置距离底部多远」：内容超过一屏时
   * scrollTop 停在 0，位置判断会得出"远离底部"从而永不跟随 —— 这正是首版实现的 bug。
   */
  const userScrolledAwayRef = useRef(false);
  /** 思考块内部的「用户手动上翻」标记，与外层各自独立 */
  const thinkingScrolledAwayRef = useRef(false);

  // 切换查看的子 Agent 时重置跟随状态（弹窗通常整体挂载/卸载，此处兜底）
  useEffect(() => {
    userScrolledAwayRef.current = false;
    thinkingScrolledAwayRef.current = false;
  }, [agent.id]);

  /**
   * 流式输出时跟随到底部；用户手动上翻后暂停，滚回底部自动恢复。
   *
   * 依赖 agent.events 而非某几个派生字符串：工具调用的开闭与状态流转同样会改变
   * 内容高度，漏掉这些维度会让工具阶段完全不跟随（实测外层卡住数秒不动）。
   *
   * 必须**同时**滚思考块内层：.agent-detail-body .thinking-content 带
   * max-height:320px + overflow-y:auto，思考超出 320px 后是在内层撑高、外层
   * scrollHeight 不变 —— 只滚外层等于什么都没做，这正是「思考不跟随」的根因。
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (el && !userScrolledAwayRef.current) el.scrollTop = el.scrollHeight;
    const thinkEl = thinkingRef.current;
    if (thinkEl && !thinkingScrolledAwayRef.current) thinkEl.scrollTop = thinkEl.scrollHeight;
  }, [agent.events, thinkingOpen]);

  const durationSec = agent.endedAt
    ? Math.max(0, Math.round((agent.endedAt - agent.startedAt) / 1000))
    : Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000));

  // 挂到 document.body：父级 .question-panel 有 backdrop-filter + overflow，
  // 会劫持 fixed 定位并裁剪弹窗，portal 到 body 规避
  // Esc 关闭 / Tab 焦点圈禁由 ResizableModal 统一处理
  // 遮罩不响应点击：弹窗只经右上角关闭按钮或 Esc 关闭。
  // 弹窗可拖拽，鼠标滑出边界松手时若响应遮罩点击会导致意外关闭（用户反馈）。
  return createPortal(
    <div className="modal-overlay">
      <ResizableModal
        width={900}
        height="min(78vh, 720px)"
        onEsc={onClose}
      >
        <div className="agent-detail-header">
          <span className="agent-detail-title">Agent #{index}</span>
          <span className={`agent-status-badge ${agent.status}`}>
            {agent.status === 'running'
              ? '执行中'
              : agent.status === 'completed'
                ? '完成'
                : agent.status === 'aborted'
                  ? '已中止'
                  : '失败'}
          </span>
          <span className="agent-detail-duration">
            {agent.status === 'running' ? '进行中 ' : '用时 '}
            {durationSec}s
          </span>
          {/* 停止按钮：运行中显示；只中止该子代理，主代理会收到「已被用户中止」后继续自己的循环 */}
          {agent.status === 'running' && (
            <button
              type="button"
              className="agent-detail-stop"
              title="停止该子代理（主代理不受影响）"
              onClick={() => stopSubAgent(agent.id)}
            >
              停止
            </button>
          )}
          <button type="button" className="agent-detail-close" onClick={onClose}>
            &#10005;
          </button>
        </div>
        <div className="agent-detail-task">任务：{agent.task || '(未提供任务描述)'}</div>

        <div
          className="agent-detail-body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 距底部 80px 内视为「在底部」：滚回底部即恢复自动跟随
            userScrolledAwayRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
          }}
        >
          {toolCards.length === 0 && !textBuffer && !thinkingBuffer && (
            <div className="agent-detail-empty">
              {agent.eventsLost
                ? '过程未保留：刷新或切换会话后只恢复任务与结果，执行过程不回放'
                : '暂无过程事件'}
            </div>
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
              {thinkingOpen && (
                <div
                  className="thinking-content"
                  ref={thinkingRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    // 同外层：距底部 80px 内视为「在底部」，滚回底部即恢复自动跟随
                    thinkingScrolledAwayRef.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight > 80;
                  }}
                >
                  {/* 与主对话一致：思考内容走 Markdown 渲染（此前纯文本直出，代码块/列表会显示成原始标记） */}
                  <MarkdownRenderer content={thinkingBuffer} isStreaming={agent.status === 'running'} />
                </div>
              )}
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

          {/* 工具调用折叠组：直接复用主界面的 ToolCallGroup（此前本组件手写了一份，
              导致主/子两侧行为不一致、每次调整都要改两处） */}
          {toolCards.length > 0 && <ToolCallGroup toolCalls={toolCallsForGroup} />}

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
      </ResizableModal>
    </div>,
    document.body,
  );
}
