import { useState, useEffect, useCallback, useRef } from 'react';
import { useChatStore } from '../../store/chat-store';
import { apiUrl } from '../../services/api-config';
import type { ChatMessage } from '../../types/chat';

interface TokenUsage {
  estimatedTokens: number;
  maxTokens: number;
  percent: number;
  messageCount: number;
  shouldCompact: boolean;
}

const DEFAULT_MAX_TOKENS = 65535;

/**
 * 与后端 token-tracker.estimateTokensFromText 同口径：每 4 字符约 1 token。
 * 空字符串 / 空内容（undefined）返回 0 而非 1：会话存在空内容消息（如失败的
 * assistant 消息 content=''）时，避免本地估算把上下文算成 1。
 */
function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** 单条前端消息的文本 token 估算（前端 content 为纯字符串；图片按后端固定值 100） */
function estimateMessageTokens(msg: ChatMessage): number {
  let total = estimateTextTokens(msg.content);
  if (msg.thinking) total += estimateTextTokens(msg.thinking);
  for (const tc of msg.toolCalls ?? []) {
    total += estimateTextTokens(typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}));
  }
  total += (msg.images?.length ?? 0) * 100;
  return total;
}

/**
 * 计算「当前上下文占用」（前端简化实现，口径对齐后端
 * token-tracker.calculateContextTokens / getTokenUsage.estimatedTokens）：
 * - usage 侧：取所有 assistant 消息中 (usage.input + usage.output) 最大的一条——
 *   最后一条可能命中 prompt 缓存导致 input 偏小，取最大更接近真实上下文（与后端同策略），
 *   再加上该条之后所有消息的文本估算；
 * - 文本侧：全部消息按 4 字符/token 估算；
 * - 取两者较大值（usage 偏小时文本估算兜底，避免低估）。
 * 后端数据可用时（GET /tokens 返回的 estimatedTokens）直接使用后端结果（权威口径，
 * 含 system prompt），本函数仅作后端不可用时的本地兜底。
 */
function estimateContextTokens(messages: ChatMessage[]): number {
  let best: { total: number; idx: number } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.usage?.input) {
      const total = m.usage.input + (m.usage.output || 0);
      if (!best || total > best.total) best = { total, idx: i };
    }
  }
  let usageBased = 0;
  if (best) {
    usageBased = best.total;
    for (let j = best.idx + 1; j < messages.length; j++) {
      usageBased += estimateMessageTokens(messages[j]);
    }
  }
  const textBased = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
  return Math.max(usageBased, textBased);
}

/**
 * Token 用量显示条（双指标，语义分离）
 *
 * 指标一「累计消耗」：store.totalUsage.total，即会话内每次 message_end.usage.totalTokens
 * 的全量累加（totalTokens = 单次 LLM 调用的 input + output，含 cacheRead；一轮多次调用
 * 逐条累加）。它是历史累计，可能远超上下文窗口——多轮对话的正常现象，不代表当前上下文，
 * 因此绝不用于压缩判定/超窗提示。历史会话刷新后 totalUsage 为 0，用后端估算兜底。
 *
 * 指标二「上下文」：当前上下文占用，即后端压缩判定的同一口径
 * （token-tracker.calculateContextTokens：usage 侧取最大一条 assistant 的 input+output
 * 再补其后消息，文本侧 4 字符/token，取 max）。优先用后端 GET /sessions/:id/tokens 的
 * estimatedTokens，本地估算兜底。超窗（>100%）红色提示「已超窗口上限，建议压缩」只挂
 * 在此指标上——累计消耗超窗口是正常的多轮累计，不提示。
 */
export function TokenBar() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const totalUsage = useChatStore((s) => s.totalUsage);
  const messageCount = useChatStore((s) => s.messages.length);
  const messages = useChatStore((s) => s.messages);
  const compactSession = useChatStore((s) => s.compactSession);
  const switchSession = useChatStore((s) => s.switchSession);
  const [apiUsage, setApiUsage] = useState<TokenUsage | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);

  const maxTokens = apiUsage?.maxTokens ?? DEFAULT_MAX_TOKENS;

  // 指标一：累计消耗（Σ 所有 LLM 调用；运行中实时累加最准，历史会话用后端估算兜底）
  const cumulativeTokens = totalUsage.total > 0 ? totalUsage.total : (apiUsage?.estimatedTokens ?? 0);

  // 指标二：当前上下文占用（后端权威口径优先，本地估算兜底）。
  // 取 Math.max 而非「apiUsage 优先」：apiUsage 是 fetch 快照，发消息后未重新 fetch
  // 期间会落后于最新消息；本地估算随 messages 实时更新，取较大值避免旧快照低估
  // （与后端 calculateContextTokens「usage 侧与文本侧取 max」同一策略）。
  // 压缩/删除消息后两条口径都会下降，不会误报高；空会话（无消息）时两者为 0，显示 0 而非 1。
  const localEstimate = estimateContextTokens(messages);
  const contextTokens = Math.max(apiUsage?.estimatedTokens ?? 0, localEstimate);
  const contextPercent = maxTokens > 0 ? Math.round((contextTokens / maxTokens) * 100) : 0;

  // 请求序号：防止慢响应（旧会话/旧消息时发的 fetch）返回后覆盖新响应——
  // fetch 前自增记录，响应回来时序号不一致（期间又发了新请求）则丢弃。
  const fetchSeqRef = useRef(0);
  const fetchUsage = useCallback(async () => {
    if (!activeSessionId) return;
    const seq = ++fetchSeqRef.current;
    try {
      const token = localStorage.getItem('myagent_token');
      const res = await fetch(apiUrl(`/api/sessions/${activeSessionId}/tokens`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (seq === fetchSeqRef.current) setApiUsage(data);
      }
    } catch { /* ignore：失败保持本地估算（若为空显示 0） */ }
  }, [activeSessionId]);

  // 切换会话时立即重新获取
  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  // 消息变化后刷新上下文指标（修复「发消息后上下文一直不动」）：
  // messages 来自 store，流式时 message_delta 高频变化，500ms 防抖收敛为一次请求；
  // 切换会话时该 effect 与上面的立即 fetch 各触发一次，多一次请求无妨（本地服务）。
  useEffect(() => {
    const t = setTimeout(fetchUsage, 500);
    return () => clearTimeout(t);
  }, [messages, fetchUsage]);

  // 一轮生成结束（isProcessing true→false）立即刷新，不等 500ms 防抖
  const isProcessing = useChatStore((s) => s.isProcessing);
  const wasProcessingRef = useRef(false);
  useEffect(() => {
    if (wasProcessingRef.current && !isProcessing) fetchUsage();
    wasProcessingRef.current = isProcessing;
  }, [isProcessing, fetchUsage]);

  const handleCompact = async () => {
    if (!activeSessionId) return;
    setCompacting(true);
    setCompactError(null);
    try {
      const data = await compactSession(activeSessionId);
      // 压缩成功：compact 响应即新 usage（estimatedTokens 等），直接刷新上下文指标；
      // 重新拉取消息列表（消息已被摘要替换）
      setApiUsage(data);
      await switchSession(activeSessionId);
    } catch (err: any) {
      // 错误透传（修复前 404「会话不存在」被静默忽略）：按钮旁红字显示后端 message
      setCompactError(err?.message || '压缩失败');
    } finally {
      setCompacting(false);
    }
  };

  if (!apiUsage && cumulativeTokens === 0 && contextTokens === 0) return null;

  const contextColorClass = contextPercent >= 80 ? 'token-danger' :
                            contextPercent >= 60 ? 'token-warning' : 'token-safe';

  // 显示压缩按钮：后端口径（shouldCompact = 上下文 > maxTokens×80%）或前端兜底 >90%
  const showCompactBtn = (apiUsage?.shouldCompact ?? false) || contextPercent > 90;

  return (
    <div className="token-bar">
      <span className="token-bar-text">
        <span title="会话内所有 LLM 调用的 token 累加（多轮累计，可能超过窗口，不代表当前上下文）">
          累计消耗: {cumulativeTokens.toLocaleString()} tokens
        </span>
        <span className="token-sep"> · </span>
        <span title="当前上下文占用（与后端压缩判定口径一致）">
          上下文: <span className={contextColorClass}>{contextTokens.toLocaleString()}</span> / {maxTokens.toLocaleString()} ({contextPercent}%)
        </span>
        {contextPercent > 100 && (
          <span className="token-danger"> · 已超窗口上限，建议压缩</span>
        )}
        <span> · {messageCount} 条消息</span>
      </span>
      {showCompactBtn && (
        <button
          className="token-compact-btn"
          onClick={handleCompact}
          disabled={compacting}
        >
          {compacting ? '压缩中...' : '压缩对话'}
        </button>
      )}
      {compactError && (
        <span className="token-danger token-compact-error">{compactError}</span>
      )}
    </div>
  );
}
