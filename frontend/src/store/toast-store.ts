import { create } from 'zustand';

/**
 * 全局 toast 提示 store（轻量自实现，零新增依赖）
 *
 * 用法（任意位置直接调，无需 hook / 传参）：
 *   toast.success('连接成功')
 *   toast.error('保存失败：xxx')
 *   toast.info('正在处理...')
 *
 * 位置：弹出瞬间固定在鼠标右侧（模块级监听 mousemove 记录最后鼠标位置，
 * 不参与状态渲染）；也支持显式传位置 toast.success('xxx', { x, y })，如触摸屏场景。
 * 行为：自动淡出（显示 ~2.8s），点击立即关闭，同屏最多 3 条（超出丢弃最旧）。
 */

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  /** 屏幕坐标（fixed 基准） */
  x: number;
  y: number;
  /** 进入淡出阶段（由 ToastHost 应用退出动画） */
  leaving?: boolean;
}

const MAX_VISIBLE = 3;
const SHOW_MS = 1500; // 显示时长（之后进入淡出动画）
const EXIT_MS = 300; // 淡出动画时长

/** 模块级最后鼠标位置（默认取用；null = 从未有真实坐标，兜底右下角） */
let lastMouse: { x: number; y: number } | null = null;

// 模块加载即挂监听（而非 show 首次惰性挂载）：否则首次 toast 拿到初始 (0,0)，
// 弹出到屏幕左上角；第二次鼠标动过才正常。
// click 也作为位置信号：键盘触发（Enter/Tab 高亮后 Enter）时 mousemove 可能没跟着动。
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('click', (e) => {
    // 键盘触发的 click 坐标为 (0,0)，不更新
    if (e.clientX !== 0 || e.clientY !== 0) lastMouse = { x: e.clientX, y: e.clientY };
  });
}

interface ToastStore {
  toasts: ToastItem[];
  show: (type: ToastType, message: string, pos?: { x: number; y: number }) => void;
  /** 进入淡出阶段 */
  markLeaving: (id: number) => void;
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: (type, message, pos) => {
    // 默认取系统内屏右下角附近（无任何鼠标位置信号时的兜底，避免弹出到左上角）
    const p = pos ?? lastMouse ?? { x: window.innerWidth - 380, y: window.innerHeight - 120 };
    const id = Date.now() + Math.floor(Math.random() * 100000);

    set((s) => {
      // 同屏最多 3 条：超出丢弃最旧的
      const toasts = [...s.toasts, { id, type, message, x: p.x, y: p.y }];
      return { toasts: toasts.length > MAX_VISIBLE ? toasts.slice(toasts.length - MAX_VISIBLE) : toasts };
    });

    window.setTimeout(() => get().markLeaving(id), SHOW_MS);
    window.setTimeout(() => get().dismiss(id), SHOW_MS + EXIT_MS);
  },

  markLeaving: (id) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })),

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 全局便捷 API（组件外也能用） */
export const toast = {
  success(message: string, pos?: { x: number; y: number }): void {
    useToastStore.getState().show('success', message, pos);
  },
  error(message: string, pos?: { x: number; y: number }): void {
    useToastStore.getState().show('error', message, pos);
  },
  info(message: string, pos?: { x: number; y: number }): void {
    useToastStore.getState().show('info', message, pos);
  },
};
