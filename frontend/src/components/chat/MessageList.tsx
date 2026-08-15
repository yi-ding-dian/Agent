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
        await switchWorkDir(dirPath);

        // 拖入目录 → 自动切换到 Agent 模式
        const store = useChatStore.getState();
        const hadMessages = store.messages.length > 0;
        store.setMode('agent');

        if (hadMessages) {
          await store.createNewSession();
        }

        const hint = hadMessages
          ? `已切换至 Agent 模式并开启新对话，工作目录：${dirPath}`
          : `已切换至 Agent 模式，工作目录：${dirPath}`;
        useChatStore.setState((s) => ({
          messages: [...s.messages, {
            id: 'drop_' + Date.now(),
            role: 'system',
            content: hint,
            timestamp: Date.now(),
          }],
        }));
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
