import { useCallback, useEffect, useState } from 'react';
import * as api from '../../services/api';
import { ResizableModal } from './ResizableModal';

export interface DirBrowserProps {
  /** 打开时的起始目录 */
  currentPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  /**
   * 定位方式：
   * - `inline`（默认）：依赖父容器的定位上下文，弹窗内嵌时用（如设置页）
   * - `fixed`：视口定位 + 高层级，页面级调用时用（如 Header 的路径标签）
   *
   * 原实现写死 `position:absolute; z-index:10`，只能在设置弹窗里用 ——
   * 挂到 Header 下会相对初始包含块定位（随页面滚动，且被 .modal-overlay 的 z-index 压住）。
   */
  variant?: 'inline' | 'fixed';
  /** 最近使用过的目录（localStorage），点击即选中并关闭；空数组则不渲染该区块 */
  recentDirs?: string[];
  title?: string;
}

/**
 * 目录选择器。
 *
 * 从 SettingsModal 内部抽出（原为模块内 function、未导出），供设置页与会话工作目录切换共用。
 */
export function DirBrowser({
  currentPath,
  onSelect,
  onClose,
  variant = 'inline',
  recentDirs = [],
  title = '选择目录',
}: DirBrowserProps) {
  const [dirPath, setDirPath] = useState(currentPath);
  const [entries, setEntries] = useState<{ dirs: string[]; files: string[]; parent: string | null }>({
    dirs: [],
    files: [],
    parent: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.listDirectory(path);
      setEntries({ dirs: data.directories, files: data.files, parent: data.parent });
    } catch (e: any) {
      setError(e.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDir(dirPath);
  }, [dirPath, loadDir]);

  const joinPath = (base: string, name: string) => `${base}/${name}`.replace(/\/+/g, '/');

  return (
    <div
      className={`dir-browser-overlay${variant === 'fixed' ? ' dir-browser-overlay-fixed' : ''}`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <ResizableModal width={480} maxHeight="70vh" onEsc={onClose}>
        <div className="dir-browser-header">
          <span className="dir-browser-title">{title}</span>
          <button className="modal-close-btn" onClick={onClose}>&#10005;</button>
        </div>
        <div className="dir-browser-path">{dirPath}</div>

        {/* 最近使用：常在同一批项目目录间来回切，放最上面省去逐级点进去 */}
        {recentDirs.length > 0 && (
          <div className="dir-browser-recent">
            <div className="dir-browser-recent-label">最近使用</div>
            {recentDirs.map((d) => (
              <div
                key={d}
                className="dir-browser-recent-item"
                title={d}
                onClick={() => { onSelect(d); onClose(); }}
              >
                &#128193; {d}
              </div>
            ))}
          </div>
        )}

        <div className="dir-browser-list">
          {loading && <div className="dir-browser-loading">加载中...</div>}
          {error && <div className="dir-browser-error">{error}</div>}
          {!loading && !error && entries.parent !== null && (
            <div className="dir-browser-item dir-browser-up" onClick={() => setDirPath(entries.parent!)}>
              ..
            </div>
          )}
          {!loading && !error && entries.dirs.map((d) => (
            <div key={d} className="dir-browser-item dir-browser-dir" onClick={() => setDirPath(joinPath(dirPath, d))}>
              &#128193; {d}
            </div>
          ))}
          {!loading && !error && entries.files.map((f) => (
            <div key={f} className="dir-browser-item dir-browser-file">
              &#128196; {f}
            </div>
          ))}
          {!loading && !error && entries.dirs.length === 0 && entries.files.length === 0 && (
            <div className="dir-browser-empty">空目录</div>
          )}
        </div>
        <div className="dir-browser-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => { onSelect(dirPath); onClose(); }}>选择此目录</button>
        </div>
      </ResizableModal>
    </div>
  );
}
