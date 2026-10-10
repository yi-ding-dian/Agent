import { useChatStore } from '../../store/chat-store';

/**
 * 重新生成按钮
 * 显示在 AI 回复消息旁，点击后重新发送最后一条用户消息
 */
export function RegenerateButton() {
  const regenerate = useChatStore((s) => s.regenerateLastMessage);
  const isProcessing = useChatStore((s) => s.isProcessing);

  return (
    <button
      className="regenerate-btn"
      onClick={regenerate}
      disabled={isProcessing}
      title="重新生成回复"
    >
      &#x21bb; 重新生成
    </button>
  );
}
