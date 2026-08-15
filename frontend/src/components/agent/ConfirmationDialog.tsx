import { useChatStore } from '../../store/chat-store';

export function ConfirmationDialog() {
  const pendingConfirmation = useChatStore((s) => s.pendingConfirmation);
  const confirmDecision = useChatStore((s) => s.confirmDecision);

  if (!pendingConfirmation) return null;

  return (
    <div className="confirm-bar">
      <div className="confirm-bar-content">
        <div className="confirm-bar-info">
          <span className="confirm-bar-title">操作确认</span>
          <span className="confirm-bar-reason">{pendingConfirmation.reason}</span>
          <code className="confirm-bar-command">{pendingConfirmation.command}</code>
        </div>
        <div className="confirm-bar-actions">
          <button
            className="btn btn-block"
            onClick={() => confirmDecision('block')}
          >
            取消
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => confirmDecision('always_allow')}
          >
            始终允许
          </button>
          <button
            className="btn btn-primary"
            onClick={() => confirmDecision('allow')}
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  );
}
