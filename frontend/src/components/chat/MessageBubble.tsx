import { useState, useCallback } from 'react';
import type { ChatMessage } from '../../types/chat';
import { MarkdownRenderer } from '../common/MarkdownRenderer';
import { StreamingText } from './StreamingText';
import { ToolCallGroup } from '../agent/ToolCallGroup';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { RegenerateButton } from '../agent/RegenerateButton';
import { useChatStore } from '../../store/chat-store';

interface MessageBubbleProps {
  message: ChatMessage;
}

/** 按错误类型给出可操作建议（错误提示块用） */
function getErrorAdvice(errorMessage: string): string {
  const err = errorMessage.toLowerCase();
  if (/failed to load model|model not found|model.*not (found|exist)|unknown model|invalid.*model/i.test(err)) {
    return '当前模型未加载或不存在，请到设置→模型预设切换其他模型（如 DeepSeek-Chat），或到模型服务端加载该模型';
  }
  if (/401|403|authentication|api[ _-]?key|unauthorized|invalid key/i.test(err)) {
    return 'API Key 无效或未配置，请在设置中检查模型预设的 API Key';
  }
  if (/fetch failed|econnrefused|timeout|timed out|connection|network|socket|unreachable|no response/i.test(err)) {
    return '无法连接到模型服务，请检查模型服务地址和网络';
  }
  return '请检查模型配置或切换模型预设后重试';
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const deleteMessagePair = useChatStore((s) => s.deleteMessagePair);
  const editMessage = useChatStore((s) => s.editMessage);
  const isUser = message.role === 'user';

  if (message.role === 'system') {
    return (
      <div className="message-system">
        <span className="message-system-text">{message.content}</span>
      </div>
    );
  }

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [message.content]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const formatTokens = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  // 回合平均 token 生成速度（tok/s）：按用户要求用「输出 token」口径——
  // 输出 token 数 ÷ 回合总时长（含工具调用）。仅当 output > 0 且 duration > 0.5
  // 时返回有效值，否则返回 null（避免除零/噪声）。
  const calcTps = (outputTokens: number, duration: number): number | null => {
    if (outputTokens <= 0 || duration <= 0.5) return null;
    return outputTokens / duration;
  };
  const formatTps = (tps: number): string => {
    const rounded = Math.ceil(tps);
    if (rounded > 9999) return `${(tps / 1000).toFixed(1)}k`;
    return String(rounded);
  };
  const tps =
    message.duration !== undefined && message.usage
      ? calcTps(message.usage.output || 0, message.duration)
      : null;

  const hasThinking = !!(message.thinking);
  const hasRunningTool = (message.toolCalls || []).some((t) => t.status === 'running');

  const loadingText = hasRunningTool
    ? '正在执行工具...'
    : hasThinking
      ? '思考中...'
      : '正在生成...';

  return (
    <div className={`message-row ${isUser ? 'user' : 'assistant'}`}>
      <div className={`message-bubble ${isUser ? 'user' : 'assistant'}`}>
        {isUser ? (
          <>
            {message.images && message.images.length > 0 && (
              <div className="message-images">
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={`附件图片 ${i + 1}`}
                    className="message-image-thumb"
                    onClick={() => {
                      const overlay = document.getElementById('imageOverlay');
                      const overlayImg = document.getElementById('overlayImg') as HTMLImageElement;
                      if (overlay && overlayImg) {
                        overlayImg.src = `data:${img.mimeType};base64,${img.data}`;
                        overlay.classList.add('active');
                      }
                    }}
                  />
                ))}
              </div>
            )}
            {editing ? (
              <div className="message-edit-box">
                <textarea
                  className="message-edit-input"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={3}
                  autoFocus
                />
                <div className="message-edit-actions">
                  <button
                    className="message-action-btn"
                    onClick={() => {
                      setEditing(false);
                      editMessage(message.id, editText);
                    }}
                    title="发送修改后的消息"
                  >
                    发送
                  </button>
                  <button
                    className="message-action-btn"
                    onClick={() => setEditing(false)}
                    title="取消编辑"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              message.content && <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
            )}
          </>
        ) : (
          <>
            {message.errorMessage && (
              <div className="error-banner" role="alert">
                <div className="error-banner-title">
                  <span className="error-banner-icon">⚠️</span>
                  模型连接失败
                </div>
                <div className="error-banner-reason">
                  {message.errorMessage.slice(0, 200)}
                  {message.errorMessage.length > 200 ? '…' : ''}
                </div>
                <div className="error-banner-advice">建议：{getErrorAdvice(message.errorMessage)}</div>
              </div>
            )}
            {hasThinking && (
              <div className="thinking-block">
                <div
                  className="thinking-header"
                  onClick={() => setThinkingExpanded(!thinkingExpanded)}
                >
                  <span className="thinking-chevron">{thinkingExpanded ? '▼' : '▶'}</span>
                  <span className="thinking-label">
                    {message.isStreaming && !message.content ? '思考中...' : '思考过程'}
                  </span>
                </div>
                {(thinkingExpanded || message.isStreaming) && (
                  <div className="thinking-content">
                    <MarkdownRenderer content={message.thinking || ''} isStreaming={message.isStreaming} />
                  </div>
                )}
              </div>
            )}
            {message.content ? (
              message.isStreaming ? (
                <StreamingText content={message.content} isStreaming />
              ) : (
                <MarkdownRenderer content={message.content} />
              )
            ) : message.isStreaming && !message.errorMessage ? (
              hasThinking ? null : <LoadingSpinner size={12} text={loadingText} />
            ) : null}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <ToolCallGroup toolCalls={message.toolCalls} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="message-meta">
        <span>{formatTime(message.timestamp)}</span>
        {!isUser && message.usage && (
          <span className="message-tokens" title={`输入 ${message.usage.input} + 输出 ${message.usage.output} tokens（合计 ${message.usage.totalTokens}）`}>
            · 输出 {formatTokens(message.usage.output || 0)} tokens
          </span>
        )}
        {!isUser && message.llmCallCount && message.llmCallCount > 1 && (
          <span className="message-tokens">· {message.llmCallCount} 次调用</span>
        )}
        {!isUser && message.duration !== undefined && (
          <span className="message-tokens">· {message.duration}s</span>
        )}
        {tps !== null && (
          <span
            className="message-tokens"
            title="回合平均速度：输出 token ÷ 回合总时长（含工具调用）"
          >
            · {formatTps(tps)} tok/s
          </span>
        )}
        <div className="message-actions">
          <button className="message-action-btn" onClick={handleCopy} title="复制">
            {copied ? '✓' : '📋'}
          </button>
          {isUser && (
            <button
              className="message-action-btn"
              onClick={() => {
                setEditText(message.content);
                setEditing(true);
              }}
              title="编辑并重新发送"
            >
              ✏️
            </button>
          )}
          {!isUser && (
            <>
              <RegenerateButton />
              <button
                className="message-action-btn message-delete-btn"
                onClick={() => deleteMessagePair(message.id)}
                title="删除此回复"
              >
                🗑
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
