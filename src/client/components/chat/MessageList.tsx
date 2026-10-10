import { useEffect, useRef, useCallback, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { useAuthStore } from '../../store/auth-store';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const isProcessing = useChatStore((s) => s.isProcessing);
  const setScrolledAway = useChatStore((s) => s.setScrolledAway);
  const scrollToBottom = useChatStore((s) => s.scrollToBottom);
  const scrollToBottomTrigger = useChatStore((s) => s.scrollToBottomTrigger);
  const switchWorkDir = useChatStore((s) => s.switchWorkDir);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const user = useAuthStore((s) => s.user);
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledAway = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // 深度监听最后一条消息的所有变化
  const lastMsg = messages[messages.length - 1];
  const lastContent = lastMsg?.content ?? '';
  const lastThinking = lastMsg?.thinking ?? '';
  const lastToolCount = lastMsg?.toolCalls?.length ?? 0;
  const isStreaming = lastMsg?.isStreaming ?? false;
  const lastToolStatus = lastToolCount > 0 ? lastMsg?.toolCalls?.[lastToolCount - 1]?.status ?? '' : '';

  // 检测用户是否主动上滑查看历史
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    userScrolledAway.current = !atBottom;
    setScrolledAway(!atBottom);
  }, [setScrolledAway]);

  // 自动跟随滚动（仅在用户没有主动上滑时）
  useEffect(() => {
    if (userScrolledAway.current) return;
    const behavior = isProcessing || isStreaming ? 'instant' : 'smooth';
    bottomRef.current?.scrollIntoView({ behavior });
  }, [messages.length, lastContent, lastThinking, lastToolCount, lastToolStatus, isProcessing, isStreaming]);

  // 外部触发滚动到底部
  useEffect(() => {
    if (scrollToBottomTrigger > 0) {
      userScrolledAway.current = false;
      setScrolledAway(false);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [scrollToBottomTrigger, setScrolledAway]);

  // 切换会话时重置滚动状态
  useEffect(() => {
    userScrolledAway.current = false;
    setScrolledAway(false);
  }, [activeSessionId, setScrolledAway]);

  // 文件/目录拖拽处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const file = e.dataTransfer.files[0];
    if (!file) return;

    if (window.myagent) {
      try {
        const dirPath = await window.myagent.getDropDirPath(file);
        // 拖入目录 = 切「当前会话」的工作目录，消息历史原样保留。
        // 原先这里是「有历史就 createNewSession」，那是全局 workDir 时代的权宜 ——
        // 会话级之后没必要另起会话，且用户明确要求保留历史。
        // 反馈由 switchWorkDir 里的 directoryNotice 横幅承担，不再往消息流里塞 system 消息
        // （那种前端内存消息会在下次 persistMessages 时被顺带写进 DB）。
        await switchWorkDir(dirPath);

        // 拖目录的人意图是「在这个目录里干活」，顺带切到 Agent 模式
        useChatStore.getState().setMode('agent');
      } catch {
        // ignore
      }
    } else {
      useChatStore.setState((s) => ({
        messages: [...s.messages, {
          id: 'drop_' + Date.now(),
          role: 'system',
          content: '拖拽切换工作目录仅在桌面应用中可用',
          timestamp: Date.now(),
        }],
      }));
    }
  }, [switchWorkDir]);

  const dragClass = isDragOver ? ' drag-over' : '';

  if (messages.length === 0) {
    return (
      <div
        className={`message-list${dragClass}`}
        ref={listRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="empty-state">
          <div className="empty-state-icon">&#9889;</div>
          <div className="empty-state-text">
            {user ? `${user.username}，你好呀~` : '欢迎使用 Agent'}
          </div>
          {user?.last_logout_at ? (
            <div className="empty-state-hint">上次最后访问时间为：{user.last_logout_at}</div>
          ) : (
            <div className="empty-state-hint">发送一条消息开始与 AI 交流</div>
          )}
          <div className="empty-state-modes">
            <div className="empty-state-mode">&#128172; 对话模式适合问答式对话</div>
            <div className="empty-state-mode">&#129302; Agent 模式适合协作式对话</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`message-list${dragClass}`}
      ref={listRef}
      onScroll={handleScroll}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isProcessing && messages[messages.length - 1]?.role === 'user' && (
        <ThinkingIndicator />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
