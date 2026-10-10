import { useChatStore } from '../../store/chat-store';

/**
 * 消息队列指示器
 * 显示三种状态：
 * - 等待处理：队列中有未 steered 的消息
 * - 部分处理：部分已 steered，部分还在等待
 * - 全部已处理：所有消息已通过 steer 注入 AI 上下文
 */
export function QueueIndicator() {
  const queue = useChatStore((s) => s.messageQueue);
  const steerCount = useChatStore((s) => s.steerQueueCount);
  const isProcessing = useChatStore((s) => s.isProcessing);

  if (queue.length === 0 || !isProcessing) return null;

  const pendingCount = queue.length - steerCount;

  // 全部等待中
  if (pendingCount > 0 && steerCount === 0) {
    return (
      <div className="queue-indicator">
        <span className="queue-dot" />
        <span>队列中 {queue.length} 条消息等待处理</span>
      </div>
    );
  }

  // 部分已处理
  if (pendingCount > 0 && steerCount > 0) {
    return (
      <div className="queue-indicator queue-indicator--partial">
        <span className="queue-dot queue-dot--green" />
        <span>已处理 {steerCount} 条，{pendingCount} 条等待处理</span>
      </div>
    );
  }

  // 全部已处理（steerCount === queue.length）
  return (
    <div className="queue-indicator queue-indicator--done">
      <span className="queue-dot queue-dot--green" />
      <span>队列中消息已处理</span>
    </div>
  );
}
