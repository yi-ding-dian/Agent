import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { AgentDetailModal } from '../agent/AgentDetailModal';
import type { AgentInfo } from '../../types/chat';

/**
 * 从消息 content 提取纯文本。
 * content 可能是字符串（当前 store 内 user 消息均为字符串）；
 * 为兼容旧格式/后端原始结构（content 为 block 数组），数组时取 text 块拼接。
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
  }
  return '';
}

/** 折叠空白/换行后截断到 max 字符，超长追加 "…" */
function truncate(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

/**
 * 侧边面板（对话区右侧浮动栏）：tab 切换「历史问题」/「Agent列表」。
 * 平时半透明，鼠标滑过不透明（样式见 index.css）。
 * - 历史问题：点击问题项滚动定位到对应的用户消息。
 * - Agent列表：subagent 工具实时驱动的子代理列表，点击弹出详情弹窗。
 */
export function QuestionPanel() {
  const messages = useChatStore((s) => s.messages);
  const agents = useChatStore((s) => s.agents);
  const [activeTab, setActiveTab] = useState<'questions' | 'agents'>('questions');
  // 只存 id，渲染时从 store 实时取最新对象（events 持续追加 → 弹窗流式实时刷新；
  // 若直接存对象引用，store 更新后弹窗会冻结在打开瞬间的快照）
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const questions = useMemo(
    () =>
      messages
        .filter((m) => m.role === 'user')
        .map((m) => ({ id: m.id, text: truncate(extractTextContent(m.content)) })),
    [messages],
  );

  // 当前高亮：最后一条 user 消息
  const activeIndex = questions.length - 1;

  const scrollToQuestion = (index: number) => {
    // user 消息按数组顺序渲染，.message-row.user 的 DOM 顺序与 questions 正序一一对应
    const rows = document.querySelectorAll('.message-list .message-row.user');
    const target = rows[index] as HTMLElement | undefined;
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const runningCount = agents.filter((a) => a.status === 'running').length;

  // 子Agent列表可关闭（仅隐藏显示，不影响正在执行的任务）；
  // 无任务时不显示 tab；新任务到来时自动重新显示
  const [agentsClosed, setAgentsClosed] = useState(false);
  useEffect(() => {
    if (agents.length > 0) setAgentsClosed(false);
  }, [agents.length]);

  const agentsTabVisible = agents.length > 0 && !agentsClosed;

  return (
    <aside className="question-panel" aria-label="侧边面板">
      <div className="side-panel-tabs">
        <button
          type="button"
          className={`side-panel-tab${activeTab === 'questions' ? ' active' : ''}`}
          onClick={() => setActiveTab('questions')}
        >
          历史问题
        </button>
        {agentsTabVisible && (
          <button
            type="button"
            className={`side-panel-tab${activeTab === 'agents' ? ' active' : ''}`}
            onClick={() => setActiveTab('agents')}
          >
            子Agent{runningCount > 0 ? ` (${runningCount})` : ''}
          </button>
        )}
        {activeTab === 'agents' && agentsTabVisible && (
          <button
            type="button"
            className="side-panel-close"
            title="关闭子Agent列表（不影响正在执行的任务，新任务到来时自动恢复）"
            onClick={() => {
              setAgentsClosed(true);
              setActiveTab('questions');
            }}
          >
            &#10005;
          </button>
        )}
      </div>

      {activeTab === 'questions' ? (
        questions.length === 0 ? (
          <div className="question-panel-empty">暂无历史问题</div>
        ) : (
          <ul className="question-panel-list">
            {questions.map((q, i) => (
              <li key={q.id}>
                <button
                  type="button"
                  className={`question-item${i === activeIndex ? ' active' : ''}`}
                  title={q.text}
                  onClick={() => scrollToQuestion(i)}
                >
                  {q.text}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : agents.length === 0 ? (
        <div className="question-panel-empty">暂无 Agent 任务</div>
      ) : (
        <ul className="agent-list">
          {agents.map((agent, i) => {
            const duration = agent.endedAt
              ? Math.max(0, Math.round((agent.endedAt - agent.startedAt) / 1000))
              : Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000));
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className="agent-item"
                  data-agent-id={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <span className="agent-item-index">{i + 1}</span>
                  <span className={`agent-status-badge ${agent.status}`}>
                    {agent.status === 'running'
                      ? '执行中'
                      : agent.status === 'completed'
                        ? '完成'
                        : '失败'}
                  </span>
                  <span className="agent-item-task" title={agent.task}>
                    {truncate(agent.task, 40)}
                  </span>
                  <span className="agent-item-duration">
                    {agent.status === 'running' ? `${duration}s 中` : `${duration}s`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          index={agents.findIndex((a) => a.id === selectedAgent.id) + 1 || 0}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </aside>
  );
}
