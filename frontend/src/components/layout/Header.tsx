import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { SettingsModal } from './SettingsModal';
import { ModeSwitch } from '../input/ModeSwitch';
import {
  getTheme,
  setTheme,
  ensureHighlightTheme,
  THEME_CHANGE_EVENT,
  THEME_NAMES,
  THEME_LABELS,
  type ThemeName,
} from '../../services/theme';

export function Header() {
  const mode = useChatStore((s) => s.mode);
  const error = useChatStore((s) => s.error);
  const clearError = useChatStore((s) => s.clearError);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setActiveTheme] = useState<ThemeName>(() => getTheme());

  // 挂载时读取当前主题选中态；监听自定义事件与 storage 事件保持同步
  useEffect(() => {
    const sync = () => setActiveTheme(getTheme());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleThemeClick = (name: ThemeName) => {
    setTheme(name); // 设置 data-theme + localStorage + 派发事件
    void ensureHighlightTheme(name); // 同步 hljs 代码高亮样式
  };

  return (
    <>
      <div className="header">
        <div className="header-left">
          <span className={`mode-badge ${mode}`}>
            {mode === 'chat' ? '对话模式' : 'Agent 模式'}
          </span>
          <div className="theme-dots" role="group" aria-label="主题切换">
            {THEME_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className={`theme-dot ${name}${theme === name ? ' active' : ''}`}
                title={THEME_LABELS[name]}
                aria-label={THEME_LABELS[name]}
                aria-pressed={theme === name}
                onClick={() => handleThemeClick(name)}
              />
            ))}
          </div>
          <ModeSwitch />
        </div>
        <div className="header-right">
          <button
            className="settings-btn"
            onClick={() => setShowSettings(true)}
            title="设置"
          >
            &#9881;
          </button>
        </div>
      </div>
      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button className="error-close-btn" onClick={clearError}>
            &#10005;
          </button>
        </div>
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
