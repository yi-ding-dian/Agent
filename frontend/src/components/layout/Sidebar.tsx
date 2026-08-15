import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatStore } from '../../store/chat-store';
import { useAuthStore } from '../../store/auth-store';
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

  const startDelete = () => {
    const el = itemRef.current;
    if (!el) return;
    // 1) 列表项立即让位：塌陷隐藏 → 下方会话马上补位（与动画无关）
    setRemoving(true);

    // 2) 创建飞行体（body 级 fixed，完整播放飞出动画，不被列表容器裁剪）
    const r = el.getBoundingClientRect();
    const fly = el.cloneNode(true) as HTMLElement;
    fly.className = fly.className
      .replace(/\bactive\b/g, '')
      .replace(/\bsession-item-removing\b/g, '')
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
    fly.addEventListener('animationend', () => {
      clearInterval(timer);
      for (const g of ghostsRef.current) g.remove();
      ghostsRef.current = [];
      fly.remove();
      onDelete(session.id);
    });
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
      className={`session-item${isActive ? ' active' : ''}${removing ? ' session-item-removing' : ''}`}
      onClick={() => onSwitch(session.id)}
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
          startDelete(); // 列表项让位 + body 级飞行体动画，结束后真正删除
        }}
        title="删除会话"
      >
        &#10005;
      </button>
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
      alert('Electron 客户端暂不支持会话导出（服务端模式可用）');
      return;
    }
    try {
      await exportSession(activeSessionId);
    } catch (e: any) {
      alert(e?.message || '导出失败');
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    if (isElectron()) {
      alert('Electron 客户端暂不支持会话导入（服务端模式可用）');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    if (isElectron()) {
      alert('Electron 客户端暂不支持会话导入（服务端模式可用）');
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error('文件内容为空');
      const session = await importSession(text);
      await loadSessions();
      await switchSession(session.id);
    } catch (err: any) {
      alert(err?.message || '导入失败');
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
