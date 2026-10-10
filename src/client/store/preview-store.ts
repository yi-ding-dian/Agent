import { create } from 'zustand';

/**
 * HTML 预览浮层状态（Markdown 渲染 / 代码块的「预览」按钮触发，App 根渲染浮层）
 */
interface PreviewStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const usePreviewStore = create<PreviewStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
