import { useToastStore, type ToastItem } from '../../store/toast-store';

/**
 * 全局 toast 提示宿主（挂载一次于 App 根部）
 *
 * 渲染 store 中的 toast 列表；每条 fixed 定位在鼠标右侧（弹出时坐标，
 * 视口内自动收边防溢出），进入 leaving 后播放淡出动画。
 */
const MAX_WIDTH = 340;
const MAX_LINE = 3; // 消息最多 3 行（超出截断，避免长文本遮满屏幕）

/** 屏幕内收边：鼠标靠右/靠下时把提示限制在视口内 */
function clampPos(x: number, y: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(8, Math.min(x + 16, vw - MAX_WIDTH - 12)),
    y: Math.max(8, Math.min(y + 12, vh - 64 - 12)),
  };
}

const TYPE_ICON: Record<ToastItem['type'], string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="toast-host">
      {toasts.map((t) => {
        const pos = clampPos(t.x, t.y);
        return (
          <div
            key={t.id}
            className={`toast-item ${t.type}${t.leaving ? ' leaving' : ''}`}
            style={{ left: pos.x, top: pos.y, maxWidth: MAX_WIDTH }}
            onClick={() => dismiss(t.id)}
            title="点击关闭"
          >
            <span className="toast-icon">{TYPE_ICON[t.type]}</span>
            <span className="toast-message" style={{ WebkitLineClamp: MAX_LINE }}>
              {t.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}
