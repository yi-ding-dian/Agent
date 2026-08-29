import { create } from 'zustand';

/**
 * 全局确认弹窗通道（Promise 风格，替代 window.confirm）
 *
 * 用法（任意位置，async/await）：
 *   const result = await confirmDialog.confirm({
 *     title: '删除预设',
 *     message: `删除预设 "xxx"？`,
 *     danger: true,
 *     confirmLabel: '删除',
 *   });
 *   if (result !== 'confirm') return;
 *
 * 返回：'confirm'（主按钮）/ 'cancel'（取消/Esc/遮罩）/'secondary'（副按钮，仅在传入 secondaryLabel 时可能）。
 * 与 Toast 相同：ConfirmDialogHost 挂载 App 根部渲染一次，任意组件直接调 API。
 */

export type ConfirmResult = 'confirm' | 'cancel' | 'secondary';

export interface ConfirmRequest {
  id: number;
  title: string;
  message: string;
  /** 主按钮是否红色（危险操作） */
  danger?: boolean;
  confirmLabel?: string;
  secondaryLabel?: string;
  /** 副按钮是否红色（危险选项） */
  secondaryDanger?: boolean;
  /** 隐藏「取消」按钮：仅"知道了"一种回应（信息型通知） */
  hideCancel?: boolean;
  /** 弹窗宽度（默认 440） */
  width?: number;
}

interface ConfirmStore {
  request: ConfirmRequest | null;
  show: (req: Omit<ConfirmRequest, 'id'>) => Promise<ConfirmResult>;
  resolve: (id: number, result: ConfirmResult) => void;
}

let seq = 0;
let pendingResolver: ((r: ConfirmResult) => void) | null = null;

export const useConfirmStore = create<ConfirmStore>((set) => ({
  request: null,
  show: (req) => {
    // 已打开时先取消旧的（保持单实例确认）
    if (pendingResolver) {
      pendingResolver('cancel');
      pendingResolver = null;
    }
    return new Promise<ConfirmResult>((resolve) => {
      pendingResolver = resolve;
      set({ request: { ...req, id: ++seq } });
    });
  },
  resolve: (id, result) => {
    set((s) => ({ request: s.request?.id === id ? null : s.request }));
    if (pendingResolver) {
      pendingResolver(result);
      pendingResolver = null;
    }
  },
}));

/** 全局便捷 API（组件外也能用） */
export const confirmDialog = {
  confirm(req: Omit<ConfirmRequest, 'id'>): Promise<ConfirmResult> {
    return useConfirmStore.getState().show(req);
  },
};
