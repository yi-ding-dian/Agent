import type { ExtensionUIRequest } from '../../types/chat';
import { useChatStore } from '../../store/chat-store';

/**
 * 扩展 UI 交互组件
 * 处理 confirm/select/input/notify 等交互类型
 */
export function ExtensionUIDialog() {
  const request = useChatStore((s) => s.extensionUI);
  const resolve = useChatStore((s) => s.resolveExtensionUI);

  if (!request) return null;

  if (request.method === 'notify') {
    const bg = request.notifyType === 'error' ? 'var(--danger-bg)' :
               request.notifyType === 'warning' ? 'var(--warning-bg)' : 'var(--info-bg)';
    const border = request.notifyType === 'error' ? 'var(--danger-border)' :
                  request.notifyType === 'warning' ? 'var(--warning-border)' : 'var(--info-border)';
    return (
      <div className="ext-ui-bar" style={{ background: bg, borderColor: border }}>
        <span>{request.message || request.title}</span>
        <button onClick={() => resolve(request.id, { cancelled: true })}>&#10005;</button>
      </div>
    );
  }

  if (request.method === 'confirm') {
    return (
      <div className="ext-ui-bar confirm-bar">
        <span>{request.title}</span>
        {request.message && <small>{request.message}</small>}
        <div className="ext-ui-actions">
          <button className="btn-cancel" onClick={() => resolve(request.id, { confirmed: false })}>取消</button>
          <button className="btn-confirm" onClick={() => resolve(request.id, { confirmed: true })}>确认</button>
        </div>
      </div>
    );
  }

  if (request.method === 'select' && request.options) {
    return (
      <div className="ext-ui-bar">
        <span>{request.title}</span>
        <div className="ext-ui-actions">
          {request.options.map((opt) => (
            <button key={opt} className="btn-option" onClick={() => resolve(request.id, { value: opt })}>
              {opt}
            </button>
          ))}
          <button className="btn-cancel" onClick={() => resolve(request.id, { cancelled: true })}>取消</button>
        </div>
      </div>
    );
  }

  if (request.method === 'input') {
    let inputValue = '';
    return (
      <div className="ext-ui-bar">
        <span>{request.title}</span>
        <input
          type="text"
          placeholder={request.placeholder}
          onChange={(e) => { inputValue = e.target.value; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') resolve(request.id, { value: inputValue });
          }}
          autoFocus
        />
        <div className="ext-ui-actions">
          <button className="btn-confirm" onClick={() => resolve(request.id, { value: inputValue })}>确定</button>
          <button className="btn-cancel" onClick={() => resolve(request.id, { cancelled: true })}>取消</button>
        </div>
      </div>
    );
  }

  return null;
}
