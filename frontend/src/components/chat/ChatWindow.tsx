import { useState, useCallback, useEffect } from 'react';
import { useChatStore } from '../../store/chat-store';
import { MessageList } from './MessageList';
import { QuestionPanel } from './QuestionPanel';
import { InputBar } from '../input/InputBar';
import { Header } from '../layout/Header';
import { ConfirmationDialog } from '../agent/ConfirmationDialog';
import { ExtensionUIDialog } from '../agent/ExtensionUIDialog';
import { TokenBar } from '../agent/TokenBar';
import { QueueIndicator } from '../input/QueueIndicator';
import { MagicFly } from './MagicFly';

/** 判断拖放项是否包含目录（而非单纯的文件） */
function hasDirectory(dataTransfer: DataTransfer): boolean {
  const items = dataTransfer.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as any;
    if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry?.isDirectory) return true;
    }
  }
  return false;
}

/** 返回拖放中的图片文件列表 */
function getImageFiles(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files).filter((f) => f.type.startsWith('image/'));
}

function extractDirPath(dataTransfer: DataTransfer): string | null {
  // 方案1: Electron/桌面环境 — file.path 提供绝对路径
  const files = dataTransfer.files;
  const first = files[0] as any;
  if (typeof first?.path === 'string' && first.path) {
    let commonDir = first.path;
    for (let i = 1; i < files.length; i++) {
      const fp = (files[i] as any)?.path;
      if (typeof fp === 'string') {
        while (!fp.startsWith(commonDir)) {
          const sep = commonDir.lastIndexOf('/');
          if (sep <= 0) break;
          commonDir = commonDir.slice(0, sep);
        }
      }
    }
    const lastSep = commonDir.lastIndexOf('/');
    return lastSep > 0 ? commonDir.slice(0, lastSep) : commonDir;
  }

  // 方案2: Linux 桌面环境 — text/uri-list 包含 file:// URI
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    const lines = uriList.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('file://')) {
        try {
          const decoded = decodeURIComponent(trimmed.replace(/^file:\/\//, ''));
          // 去掉末尾的换行符和空格
          const clean = decoded.replace(/[\r\n\s]+$/, '');
          if (clean.startsWith('/')) {
            // 如果是目录，可能需要去掉末尾斜杠
            return clean.replace(/\/$/, '');
          }
        } catch {
          // 解码失败，继续尝试
        }
      }
    }
  }

  // 方案3: text/plain 可能直接包含路径
  const plainText = dataTransfer.getData('text/plain');
  if (plainText) {
    const trimmed = plainText.trim();
    if (trimmed.startsWith('/') && !trimmed.includes('\n')) {
      return trimmed;
    }
    if (trimmed.startsWith('file://')) {
      try {
        const decoded = decodeURIComponent(trimmed.replace(/^file:\/\//, ''));
        const clean = decoded.replace(/[\r\n\s]+$/, '');
        if (clean.startsWith('/')) return clean.replace(/\/$/, '');
      } catch { /* ignore */ }
    }
  }

  return null;
}

export function ChatWindow() {
  const scrolledAway = useChatStore((s) => s.scrolledAway);
  const scrollToBottom = useChatStore((s) => s.scrollToBottom);
  const switchWorkDir = useChatStore((s) => s.switchWorkDir);
  const directoryNotice = useChatStore((s) => s.directoryNotice);
  const clearDirectoryNotice = useChatStore((s) => s.clearDirectoryNotice);
  const addDropFiles = useChatStore((s) => s.addDropFiles);
  const dragClearSignal = useChatStore((s) => s.dragClearSignal);
  const [dragOver, setDragOver] = useState(false);
  const [dragType, setDragType] = useState<'dir' | 'file' | null>(null);

  // InputBar 消费 drop 后通知清除遮罩
  useEffect(() => {
    setDragOver(false);
    setDragType(null);
  }, [dragClearSignal]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
      setDragType(hasDirectory(e.dataTransfer) ? 'dir' : 'file');
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 🔧 修复：检查鼠标是否真的离开了整个容器
    // relatedTarget 是鼠标离开后进入的目标元素
    // 如果它还在容器内，说明只是从子元素移到了另一个子元素，不应清除状态
    const current = e.currentTarget as HTMLElement;
    const relatedTarget = e.relatedTarget as Node | null;
    
    if (relatedTarget && current.contains(relatedTarget)) {
      return; // 鼠标仍在容器内，不处理
    }
    
    setDragOver(false);
    setDragType(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      setDragType(null);

      const dt = e.dataTransfer;

      // 明确是目录 → 切换工作目录（只在 webkitGetAsEntry 确认时）
      if (hasDirectory(dt)) {
        const dirPath = extractDirPath(dt);
        console.log('[ChatWindow] 拖放目录:', dirPath);
        if (dirPath) {
          await switchWorkDir(dirPath);
        }
        return;
      }

      // 有图片文件 → 传给 InputBar 作为附件
      const imageFiles = getImageFiles(dt);
      if (imageFiles.length > 0) {
        console.log(`[ChatWindow] 拖放 ${imageFiles.length} 个图片文件 → InputBar`);
        addDropFiles(imageFiles);
        return;
      }

      // 有文件但非图片 → 从文件数量推断可能是目录（webkitGetAsEntry 不可用时）
      // 尝试 extractDirPath 兜底
      if (dt.files.length > 0 && dt.files[0].type === '') {
        const dirPath = extractDirPath(dt);
        if (dirPath) {
          console.log('[ChatWindow] 拖放（推断为目录）:', dirPath);
          await switchWorkDir(dirPath);
        }
      }
    },
    [switchWorkDir, addDropFiles],
  );

  return (
    <div
      className={`chat-area${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="drag-overlay">
          {dragType === 'dir' ? '释放以切换工作目录' : '释放以添加附件'}
        </div>
      )}
      <Header />
      {directoryNotice && (
        <div className="dir-notice">
          <span>当前工作目录已切换至 '{directoryNotice}'</span>
          <button className="dir-notice-close" onClick={clearDirectoryNotice}>
            &#10005;
          </button>
        </div>
      )}
      <div className="chat-body">
        {/* 左列：对话区 + 输入框（输入框与对话区同宽，不延伸到右侧面板下方） */}
        <div className="chat-main">
          <div className="message-area-wrapper">
            <MessageList />
            <div className="message-area-overlay">
              <TokenBar />
              {scrolledAway && (
                <button className="scroll-down-btn" onClick={scrollToBottom}>
                  &#8595; 最新消息
                </button>
              )}
            </div>
          </div>
          <InputBar />
        </div>
        <QuestionPanel />
      </div>
      <ConfirmationDialog />
      <ExtensionUIDialog />
      <QueueIndicator />
      {/* 魔法飞行动画：subagent 派出时从消息区飞向 Agent 面板 */}
      <MagicFly />
    </div>
  );
}
