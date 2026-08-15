import { useChatStore } from '../../store/chat-store';
import type { AgentMode } from '../../types/chat';

export function ModeSwitch() {
  const mode = useChatStore(s => s.mode);
  const setMode = useChatStore(s => s.setMode);
  const messages = useChatStore(s => s.messages);

  // 已有消息时锁定 mode，不允许切换
  const locked = messages.length > 0;

  const handleModeChange = (newMode: AgentMode) => {
    if (locked) return;
    setMode(newMode);
  };

  return (
    <div className="mode-switch" style={{ display: locked ? 'none' : undefined }}>
      <button
        className={`mode-switch-btn${mode === 'chat' ? ' active' : ''}`}
        onClick={() => handleModeChange('chat')}
      >
        对话
      </button>
      <button
        className={`mode-switch-btn${mode === 'agent' ? ' active' : ''}`}
        onClick={() => handleModeChange('agent')}
      >
        Agent
      </button>
    </div>
  );
}
