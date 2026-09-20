import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatStore } from '../../store/chat-store';
import { useAuthStore } from '../../store/auth-store';
import { toast } from '../../store/toast-store';
import type { SessionInfo } from '../../types/chat';
import { exportSession, importSession } from '../../services/api';
import { isElectron } from '../../services/api-config';

const STORAGE_KEY = 'myagent-sidebar-width';
const MIN_WIDTH = 60;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 280;
const COLLAPSED_WIDTH = 0;

function getStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!isNaN(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) return w;
    }
  } catch {}
  return DEFAULT_WIDTH;
}

function SessionItem({
  session,
  isActive,
  onSwitch,
  onDelete,
  onRename,
}: {
  session: SessionInfo;
  isActive: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  // 删除动画（与补位解耦）：列表项立即塌陷让位（下方会话独立补位），
  // 飞行体克隆到 body 级播放旋转飞出动画（不被列表容器 overflow 裁剪）
  const [removing, setRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const ghostsRef = useRef<HTMLElement[]>([]);
  /** 该会话是否正在执行（含用户切走后仍在后台跑的）——驱动动态边框 */
  const running = useChatStore((s) => s.runningSessions.includes(session.id));

  /** 删除确认气泡：固定在删除按钮上方弹出（不用全局确认弹窗 —— 那是全屏遮罩样式，
      与「点一下 ✕ 就地确认」的轻量语义不符）。null = 未展开 */
  const [confirmBubble, setConfirmBubble] = useState<{ bottom: number; right: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  /** 在删除按钮正上方弹出气泡：用 fixed 定位 + 视口坐标 ——
      .sidebar 是 overflow:hidden、.session-list 是 overflow-y:auto，
      用 absolute 贴在会话项上会被这两个祖先裁剪掉 */
  const openConfirmBubble = (btn: HTMLElement) => {
    const r = btn.getBoundingClientRect();
    setConfirmBubble({
      bottom: window.innerHeight - r.top + 8,   // 气泡底边落在按钮上方 8px
      right: window.innerWidth - r.right,       // 右缘对齐按钮，向左展开（侧栏窄，向右会溢出）
    });
  };

  // 气泡展开时：点外部 / Esc 关闭
  useEffect(() => {
    if (!confirmBubble) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (bubbleRef.current?.contains(t)) return;
      // 点 ✕ 自身交给它的 onClick 处理（切换展开/收起）。若这里先关掉，
      // 那边 click 读到的仍是旧状态，会立刻又打开 —— 表现为「再点 ✕ 关不掉」
      if (t instanceof HTMLElement && t.closest('.session-item-delete')) return;
      setConfirmBubble(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmBubble(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [confirmBubble]);

  const startDelete = () => {
    const el = itemRef.current;
    if (!el) return;
    // 1) 列表项立即让位：塌陷隐藏 → 下方会话马上补位（与动画无关）
    setRemoving(true);

    // 2) 创建飞行体（body 级 fixed，完整播放飞出动画，不被列表容器裁剪）
    const r = el.getBoundingClientRect();
    const fly = el.cloneNode(true) as HTMLElement;
    // 确认气泡是临时 UI，不该跟着飞出（它的入场动画还会经冒泡掐断飞行动画，见下方 animationend）
    fly.querySelector('.session-delete-bubble')?.remove();
    fly.className = fly.className
      .replace(/\bactive\b/g, '')
      .replace(/\bsession-item-removing\b/g, '')
      .replace(/\bsession-item-running\b/g, '')
      .trim();
    fly.classList.add('session-flying');
    fly.style.left = `${r.left}px`;
    fly.style.top = `${r.top}px`;
    fly.style.width = `${r.width}px`;
    fly.style.height = `${r.height}px`;
    document.body.appendChild(fly);

    // 3) 拖尾残影：从飞行体实时克隆快照，渐隐消失（彗星尾巴效果）
    const spawnGhost = () => {
      const fr = fly.getBoundingClientRect();
      if (fr.width === 0 || fr.height === 0) return;
      const ghost = fly.cloneNode(true) as HTMLElement;
      ghost.className = ghost.className.replace('session-flying', '').trim();
      ghost.classList.add('session-item-ghost');
      ghost.style.left = `${fr.left}px`;
      ghost.style.top = `${fr.top}px`;
      ghost.style.width = `${fr.width}px`;
      ghost.style.height = `${fr.height}px`;
      document.body.appendChild(ghost);
      ghostsRef.current.push(ghost);
      requestAnimationFrame(() => {
        ghost.style.opacity = '0';
        ghost.style.transform = 'scale(0.88)';
      });
      setTimeout(() => {
        ghost.remove();
        ghostsRef.current = ghostsRef.current.filter((g) => g !== ghost);
      }, 550);
    };
    const timer = setInterval(spawnGhost, 220);

    // 4) 动画结束：清残影 → 移除飞行体 → 真正删除
    // 4) 动画结束：清残影 → 移除飞行体 → 真正删除
    // 只认飞行体自身的动画结束：animationend 会冒泡，克隆体内部任何元素的动画
    // 结束都会触发这里（确认气泡曾让飞出动画刚开头就被掐断）
    fly.addEventListener('animationend', (e) => {
      if (e.target !== fly) return;
      clearInterval(timer);
      for (const g of ghostsRef.current) g.remove();
      ghostsRef.current = [];
      fly.remove();
      onDelete(session.id);
    });
  };

  /** 删除会话：就地弹气泡二次确认，确认后再播放飞出丢弃动画；
      动画结束后由 startDelete 内部回调真正删除 */
  const handleDeleteClick = (btn: HTMLElement) => {
    // 再点一次 ✕ = 收起（避免重复弹出时残留旧定位）
    if (confirmBubble) {
      setConfirmBubble(null);
      return;
    }
    openConfirmBubble(btn);
  };

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const handleDoubleClick = () => {
    setEditName(session.name);
    setEditing(true);
  };

  const handleSave = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(session.id, trimmed);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  };

  return (
    <div
      ref={itemRef}
      className={`session-item${isActive ? ' active' : ''}${removing ? ' session-item-removing' : ''}${running ? ' session-item-running' : ''}`}
      onClick={() => onSwitch(session.id)}
      title={running ? '该会话正在执行中' : undefined}
    >
      <div className="session-item-info">
        {editing ? (
          <input
            ref={inputRef}
            className="session-rename-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div
              className="session-item-title"
              title={session.name}
              onDoubleClick={handleDoubleClick}
            >
              {session.name}
            </div>
            <div className="session-item-meta">
              {new Date(session.lastActiveAt).toLocaleDateString('zh-CN')}
            </div>
          </>
        )}
      </div>
      {/* 执行中标识：旋转加载圈（配合边框流光，让「在干活」更好认） */}
      {running && <span className="session-item-spinner" aria-hidden="true" />}
      <button
        className="session-item-edit"
        onClick={(e) => {
          e.stopPropagation();
          handleDoubleClick();
        }}
        title="重命名"
      >
        &#9998;
      </button>
      <button
        className="session-item-delete"
        onClick={(e) => {
          e.stopPropagation();
          handleDeleteClick(e.currentTarget);
        }}
        title="删除会话"
      >
        &#10005;
      </button>
      {/* 删除确认气泡：fixed 定位锚在 ✕ 上方，避开侧栏的 overflow 裁剪 */}
      {confirmBubble && (
        <div
          ref={bubbleRef}
          className="session-delete-bubble"
          style={{ bottom: confirmBubble.bottom, right: confirmBubble.right }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="session-delete-bubble-text">删除该会话？</div>
          <div className="session-delete-bubble-actions">
            <button
              type="button"
              className="session-delete-bubble-cancel"
              onClick={() => setConfirmBubble(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="session-delete-bubble-confirm"
              onClick={() => {
                setConfirmBubble(null);
                startDelete();
              }}
            >
              删除
            </button>
          </div>
          <span className="session-delete-bubble-arrow" />
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);

  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [width, setWidth] = useState(getStoredWidth);
  const [collapsed, setCollapsed] = useState(false);
  const resizing = useRef(false);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!collapsed) {
      try { localStorage.setItem(STORAGE_KEY, String(width)); } catch {}
    }
  }, [width, collapsed]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      resizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleNewSession = () => {
    createNewSession();
  };

  const handleSwitch = (id: string) => {
    if (id !== activeSessionId) {
      switchSession(id);
    }
  };

  const handleDelete = (id: string) => {
    deleteSession(id);
  };

  const handleRename = (id: string, name: string) => {
    renameSession(id, name);
  };

  // ─── 会话导出/导入（JSONL，服务端 API） ─────────────────────

  const handleExport = async () => {
    if (!activeSessionId) return;
    if (isElectron()) {
      toast.info('Electron 客户端暂不支持会话导出（服务端模式可用）');
      return;
    }
    try {
      await exportSession(activeSessionId);
    } catch (e: any) {
      toast.error(e?.message || '导出失败');
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    if (isElectron()) {
      toast.info('Electron 客户端暂不支持会话导入（服务端模式可用）');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    if (isElectron()) {
      toast.info('Electron 客户端暂不支持会话导入（服务端模式可用）');
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error('文件内容为空');
      const session = await importSession(text);
      await loadSessions();
      await switchSession(session.id);
    } catch (err: any) {
      toast.error(err?.message || '导入失败');
    }
  };

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button
          className="sidebar-expand-btn"
          onClick={() => setCollapsed(false)}
          title="展开侧边栏"
        >
          &#9654;
        </button>
      </div>
    );
  }

  return (
    <div className="sidebar" style={{ width, minWidth: width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          <button
            className="sidebar-minimize-btn"
            onClick={() => setCollapsed(true)}
            title="最小化侧边栏"
          >
            &#9664;
          </button>
          <button
            className="sidebar-icon-btn"
            onClick={handleExport}
            disabled={!activeSessionId}
            title={activeSessionId ? '导出当前会话（JSONL）' : '请先选择一个会话再导出'}
          >
            &#8681;
          </button>
          <button
            className="sidebar-icon-btn"
            onClick={handleImportClick}
            title="导入会话（JSONL）"
          >
            &#8679;
          </button>
          <button className="new-session-btn" onClick={handleNewSession} title="新建会话">
            +
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jsonl,application/jsonl,application/x-ndjson,text/plain"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
      </div>
      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">暂无会话</div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={s.id === activeSessionId}
              onSwitch={handleSwitch}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          ))
        )}
      </div>
      <div className="sidebar-resize-handle" onMouseDown={handleMouseDown} />
    </div>
  );
}
