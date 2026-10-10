import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../../store/chat-store';

/**
 * 模式选择器：点击按钮向上弹出菜单。
 *
 * 层级：主模式（对话 / Agent）+ Agent 子模式（规划——只读调研先出方案，未来可扩展）。
 * 子模式的实现与 store 对齐：planMode 是与 mode 正交的 flag（plan=true 时 mode 保持 agent）。
 */

const MAIN_MODES: { id: 'chat' | 'agent'; label: string; desc: string }[] = [
  { id: 'chat', label: '对话', desc: '自然问答，轻量工具面' },
  { id: 'agent', label: 'Agent', desc: '自动生成代码、执行、验证' },
];

/** Agent 子模式（未来新增子模式：在此加一项并映射到 store） */
const AGENT_SUBMODES: { id: 'plan'; label: string; desc: string }[] = [
  { id: 'plan', label: '📋 规划', desc: '只读调研，先出方案再执行' },
];

export function ModeMenu() {
  const mode = useChatStore((s) => s.mode);
  const planMode = useChatStore((s) => s.planMode);
  const setMode = useChatStore((s) => s.setMode);
  const setPlanMode = useChatStore((s) => s.setPlanMode);
  const messages = useChatStore((s) => s.messages);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 已有消息 → 模式已锁定，入口整块隐藏（不再留一个禁用态按钮占位）
  const locked = messages.length > 0;

  const currentLabel = planMode ? 'Agent · 规划' : mode === 'agent' ? 'Agent' : '对话';

  // Esc 关闭菜单
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 必须在所有 hooks 之后 return（React hooks 规则）
  if (locked) return null;

  const applyMainMode = (id: 'chat' | 'agent') => {
    setMode(id);
    if (id === 'chat') setPlanMode(false); // 切回对话时退出规划子模式
    setOpen(false);
  };

  const toggleSubMode = (id: 'plan') => {
    setPlanMode(id === 'plan' ? !planMode : false);
  };

  return (
    <div className="mode-menu" ref={rootRef}>
      <button
        className={`mode-menu-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="点击选择模式"
      >
        {currentLabel}
        <span className="mode-menu-chevron">▾</span>
      </button>
      {open && (
        <>
          {/* 透明遮罩：点击外部关闭 */}
          <div className="mode-menu-overlay" onClick={() => setOpen(false)} />
          <div className="mode-menu-popup">
            {MAIN_MODES.map((m) => (
              <button
                key={m.id}
                className={`mode-menu-item${mode === m.id && !planMode ? ' active' : ''}`}
                onClick={() => applyMainMode(m.id)}
              >
                <span className="mode-menu-item-label">{m.label}</span>
                <span className="mode-menu-item-desc">{m.desc}</span>
              </button>
            ))}
            {/* Agent 子模式区（分割线 + 勾选态行） */}
            <div className="mode-menu-divider" />
            {AGENT_SUBMODES.map((sub) => (
              <button
                key={sub.id}
                className={`mode-menu-item${planMode ? ' active' : ''}`}
                onClick={() => toggleSubMode(sub.id)}
                title="仅 Agent 模式生效；与 Agent 同时选中 = 先调研出计划再执行"
              >
                <span className="mode-menu-item-label">{sub.label}</span>
                <span className="mode-menu-item-desc">{sub.desc}{planMode ? '（已启用）' : ''}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
