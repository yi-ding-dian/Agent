/**
 * 主题工具：5 套主题（default/dark/ocean/forest/violet）
 * - 通过 document.documentElement 的 data-theme 属性切换（index.css 中 [data-theme=...] 覆盖变量）
 * - 持久化到 localStorage（key: myagent_theme），index.html 内联脚本在首帧前恢复，防刷新闪白
 * - 代码块语法高亮（highlight.js）按主题动态加载浅色/深色样式
 */

export type ThemeName = 'default' | 'dark' | 'ocean' | 'forest' | 'violet';

export const THEME_STORAGE_KEY = 'myagent_theme';
/** 主题切换事件名（CustomEvent<ThemeName>，Header 等组件监听保持选中态同步） */
export const THEME_CHANGE_EVENT = 'myagent:theme-change';

export const THEME_NAMES: ThemeName[] = ['default', 'dark', 'ocean', 'forest', 'violet'];

export const THEME_LABELS: Record<ThemeName, string> = {
  default: '默认主题',
  dark: '深色',
  ocean: '海洋蓝',
  forest: '森林绿',
  violet: '紫罗兰',
};

/** 校验存储值，非法/缺省返回 default */
function isThemeName(v: string | null): v is ThemeName {
  return v === 'dark' || v === 'ocean' || v === 'forest' || v === 'violet';
}

/** 读取当前主题（无存储或值非法 = default） */
export function getTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}

/** 切换主题：设置 data-theme 属性 + 持久化 + 派发事件（其他组件无需感知，纯 CSS 变量切换） */
export function setTheme(name: ThemeName): void {
  const root = document.documentElement;
  if (name === 'default') {
    root.removeAttribute('data-theme');
    try {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } catch { /* ignore */ }
  } else {
    root.setAttribute('data-theme', name);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, name);
    } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent<ThemeName>(THEME_CHANGE_EVENT, { detail: name }));
}

// ───── highlight.js 语法高亮主题（浅色 github / 深色 github-dark） ─────
// 用 ?inline 拿到 CSS 字符串后手动管理 <style>，避免动态 import 的 style 无法卸载导致深浅样式叠加

let hljsStyleEl: HTMLStyleElement | null = null;
let loadedHighlightTheme: ThemeName = 'default';

/**
 * 按主题加载对应的 hljs 高亮样式（幂等）。
 * - 深色主题 → github-dark（浅色 token，深色代码块上可读）
 * - 其余主题 → github（浅色 token，浅色代码块）
 */
export async function ensureHighlightTheme(name: ThemeName): Promise<void> {
  if (loadedHighlightTheme === name) return;
  const css = name === 'dark'
    ? (await import('highlight.js/styles/github-dark.css?inline')).default
    : (await import('highlight.js/styles/github.css?inline')).default;
  if (!hljsStyleEl) {
    hljsStyleEl = document.createElement('style');
    hljsStyleEl.setAttribute('data-hljs-theme', '');
    document.head.appendChild(hljsStyleEl);
  }
  hljsStyleEl.textContent = css;
  loadedHighlightTheme = name;
}
