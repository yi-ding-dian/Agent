import { useChatStore } from '../../store/chat-store';

export function StopButton() {
  const isProcessing = useChatStore(s => s.isProcessing);
  const stopGeneration = useChatStore(s => s.stopGeneration);

  if (!isProcessing) return null;

  return (
    <button className="stop-btn" onClick={stopGeneration}>
      &#9632; 停止
    </button>
  );
}
