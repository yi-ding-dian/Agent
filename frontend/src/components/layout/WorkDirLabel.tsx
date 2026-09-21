import { useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { DirBrowser } from '../common/DirBrowser';
import { getRecentWorkDirs } from '../../services/recent-dirs';

/** 只显示末两级，避免长路径撑破 Header；完整路径放在 title 里 */
function shortenPath(full: string): string {
  if (!full) return '';
  const parts = full.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return '/' + parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

/**
 * Header 上的「当前工作目录」标签，点击弹出目录选择器。
 *
 * 显示的是**当前会话的生效目录**：会话显式选过就用它，否则回退全局默认
 * （全局 config.work_dir 自会话级改造后只是「默认值」）。未显式选择时带一个
 * 「默认」小徽标，让用户知道改全局设置会连带影响它。
 */
export function WorkDirLabel() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const config = useChatStore((s) => s.config);
  const switchWorkDir = useChatStore((s) => s.switchWorkDir);

  const [showPicker, setShowPicker] = useState(false);
  const [switching, setSwitching] = useState(false);

  const session = sessions.find((x) => x.id === activeSessionId);
  const explicit = session?.work_dir ?? null;
  const effective = explicit || config?.work_dir || '';
  const isInherited = !explicit;

  // 无活动会话（空态）时不显示：没有会话可挂目录
  if (!activeSessionId) return null;

  const handleSelect = async (dir: string) => {
    setSwitching(true);
    try {
      await switchWorkDir(dir);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="work-dir-label"
        title={effective ? `${effective}${isInherited ? '（跟随全局默认）' : ''}` : '选择工作目录'}
        onClick={() => setShowPicker(true)}
        disabled={switching}
      >
        <span className="icon">&#128193;</span>
        <span className="path">{switching ? '切换中…' : shortenPath(effective) || '选择目录'}</span>
        {isInherited && effective && <span className="badge">默认</span>}
      </button>

      {showPicker && (
        <DirBrowser
          variant="fixed"
          title="选择工作目录"
          currentPath={effective || '/'}
          recentDirs={getRecentWorkDirs()}
          onSelect={(p) => void handleSelect(p)}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
