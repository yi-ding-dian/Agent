import { useState, useRef, useCallback, KeyboardEvent, useEffect, useMemo } from 'react';
import { useChatStore } from '../../store/chat-store';
import { StopButton } from './StopButton';
import type { ImageAttachment } from '../../types/chat';
import * as api from '../../services/api';
import {
  getModelPresets,
  getActivePresetName,
  setActivePresetName,
  type ModelPreset,
} from '../../services/api-config';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// ── 斜杠命令注册表 ─────────────────────────────────────────────
// 输入框内容以 / 开头即弹出命令联想浮层；扩展新命令只需在此数组追加一项。
// extension 字段标记该命令来自 Pi 扩展（挂载时从 GET /api/extensions/commands 拉取合并，
// 显示「扩展」徽标；执行走 POST /api/extensions/:name/command）
interface SlashCommand {
  name: string;
  description: string;
  hint: string;
  extension?: string;
}
const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'model', description: '切换默认模型', hint: '↑↓选择 Enter确认' },
  // 预留：compact（压缩对话）等后续命令可加
];

/** 方向键循环移动索引（列表为空时保持 0） */
function cycleIndex(i: number, len: number, dir: 1 | -1): number {
  return len ? (i + dir + len) % len : 0;
}

function readImageAsAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // data:image/png;base64,xxxx → 分离 mimeType 和 base64
      const commaIdx = dataUrl.indexOf(',');
      const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
      const data = dataUrl.slice(commaIdx + 1);
      const previewUrl = URL.createObjectURL(file);
      resolve({ type: 'image', data, mimeType, previewUrl });
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

export function InputBar() {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore(s => s.sendMessage);
  const queueMessage = useChatStore(s => s.queueMessage);
  const isProcessing = useChatStore(s => s.isProcessing);
  const mode = useChatStore(s => s.mode);
  const stopGeneration = useChatStore(s => s.stopGeneration);
  const pendingDropFiles = useChatStore(s => s.pendingDropFiles);
  const consumeDropFiles = useChatStore(s => s.consumeDropFiles);
  const signalDragClear = useChatStore(s => s.signalDragClear);
  const activeSessionId = useChatStore(s => s.activeSessionId);

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => {
      const next = [...prev];
      if (next[index]?.previewUrl) {
        URL.revokeObjectURL(next[index].previewUrl!);
      }
      next.splice(index, 1);
      return next;
    });
  }, []);

  // ── /model 命令：模型选择浮层 ─────────────────────────────
  // 触发：输入完整 /model 后按 Enter（不发送消息，仅弹出浮层）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPresets, setPickerPresets] = useState<ModelPreset[]>([]);
  // 检测结果（key=预设名）：本次浮层打开期间缓存，不重复请求
  const [pickerResults, setPickerResults] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({});
  // 键盘高亮：在「可连接项」数组内的索引（天然跳过不可连接项）
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerTip, setPickerTip] = useState('');
  const tipTimerRef = useRef<number | null>(null);
  // 打开浮层时快照当前默认项（浮层生命周期内不变）
  const activeNameRef = useRef<string | null>(null);

  // ── 命令联想浮层（输入 / 立即弹出，不必等 Enter） ──────────────────
  const [cmdIndex, setCmdIndex] = useState(0);
  // 扩展命令（挂载时拉取合并；本地命令重名时本地优先）
  const [extCommands, setExtCommands] = useState<SlashCommand[]>([]);
  const [extTip, setExtTip] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.listExtensionCommands()
      .then((cmds) => {
        if (cancelled) return;
        const localNames = new Set(SLASH_COMMANDS.map((c) => c.name));
        setExtCommands(
          cmds
            .filter((c) => !localNames.has(c.name)) // 本地命令优先，重名扩展命令不合并
            .map((c) => ({ name: c.name, description: c.description || '扩展命令', hint: '扩展', extension: c.extension })),
        );
      })
      .catch(() => { /* 扩展命令拉取失败不阻塞输入 */ });
    return () => { cancelled = true; };
  }, []);
  const allCommands = useMemo(() => [...SLASH_COMMANDS, ...extCommands], [extCommands]);
  // 触发：输入框内容以 / 开头即显示；查询词 = / 后内容（name 前缀匹配，大小写不敏感）
  const cmdOpen = text.startsWith('/') && !pickerOpen;
  const cmdQuery = text.startsWith('/') ? text.slice(1).trim().toLowerCase() : '';
  const matchedCmds = useMemo(
    () => allCommands.filter((c) => c.name.toLowerCase().startsWith(cmdQuery)),
    [cmdQuery, allCommands],
  );
  // 输入/删除（查询词变化）时重置高亮到第一项，避免索引越界
  useEffect(() => {
    setCmdIndex(0);
  }, [cmdQuery]);

  // 可连接项列表（检测通过的模型才能被选中）
  const connectable = useMemo(
    () => pickerPresets.filter((p) => pickerResults[p.name]?.ok),
    [pickerPresets, pickerResults],
  );

  const openPicker = useCallback(() => {
    const presets = getModelPresets();
    activeNameRef.current = getActivePresetName();
    setPickerPresets(presets);
    setPickerResults({});
    setPickerIndex(0);
    setPickerOpen(true);
    // /model 命令已被消费，清空输入框：避免 Esc 关闭后残留 "/model" 再按 Enter 重复触发
    setText('');
    // 并发检测所有模型的连通性（结果缓存在 state，本次浮层生命周期内不再请求）
    for (const p of presets) {
      api.testModelConnection(p.baseUrl, p.model, p.apiKey)
        .then((r) => setPickerResults((prev) => ({ ...prev, [p.name]: r })))
        .catch(() => setPickerResults((prev) => ({ ...prev, [p.name]: { ok: false, error: '检测失败' } })));
    }
  }, []);

  const selectPreset = useCallback((name: string) => {
    setActivePresetName(name);
    setPickerOpen(false);
    setPickerTip(`默认模型已切换：${name}（新会话生效）`);
    if (tipTimerRef.current) window.clearTimeout(tipTimerRef.current);
    tipTimerRef.current = window.setTimeout(() => setPickerTip(''), 2500);
  }, []);

  const closePicker = useCallback(() => setPickerOpen(false), []);

  /**
   * 执行扩展命令（/xxx 且带 extension 标记时）
   *
   * 方案选择（改动最小）：POST /api/extensions/:name/command 调用 handler，
   * 返回的文本作为一条用户消息发送给当前会话（结果进入 LLM 上下文，如 markitdown
   * 转换结果可由 LLM 继续处理）；无返回文本时仅显示"已执行"提示。执行失败红字提示。
   */
  const executeExtensionCommand = useCallback(async (cmd: SlashCommand) => {
    setText('');
    try {
      const r = await api.runExtensionCommand(cmd.name, '', activeSessionId || undefined);
      if (r.result) {
        sendMessage(r.result);
      } else {
        setExtTip(`命令 /${cmd.name} 已执行`);
        if (tipTimerRef.current) window.clearTimeout(tipTimerRef.current);
        tipTimerRef.current = window.setTimeout(() => setExtTip(''), 2500);
      }
    } catch (e: any) {
      setExtTip(e.message || '扩展命令执行失败');
      if (tipTimerRef.current) window.clearTimeout(tipTimerRef.current);
      tipTimerRef.current = window.setTimeout(() => setExtTip(''), 4000);
    }
  }, [activeSessionId, sendMessage]);

  /** 执行命令联想项（浮层激活时 Enter / 点击触发；openPicker 需先声明） */
  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.extension) {
      executeExtensionCommand(cmd);
      return;
    }
    if (cmd.name === 'model') {
      // 打开模型选择浮层；openPicker 内部会清空输入框 → 命令浮层随之关闭
      openPicker();
      return;
    }
    // 未知命令：仅清空输入关闭浮层（注册表外的项不会被渲染，此分支为兜底）
    setText('');
  }, [executeExtensionCommand, openPicker]);

  // 卸载时清理提示定时器
  useEffect(() => {
    return () => {
      if (tipTimerRef.current) window.clearTimeout(tipTimerRef.current);
    };
  }, []);

  const buildSendPayload = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return null;
    const images = attachments.length > 0
      ? attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      : undefined;
    return { text: trimmed, images };
  }, [text, attachments]);

  const handleSend = useCallback(() => {
    const payload = buildSendPayload();
    if (!payload) return;

    sendMessage(payload.text || '(图片)', payload.images);

    // 清理
    setText('');
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [sendMessage, buildSendPayload, attachments]);

  const handleQueue = useCallback(() => {
    const payload = buildSendPayload();
    if (!payload) return;

    queueMessage(payload.text || '(图片)', payload.images);

    setText('');
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [queueMessage, buildSendPayload, attachments]);

  const handleButtonClick = useCallback(() => {
    if (!isProcessing) {
      handleSend();
      return;
    }
    if (mode === 'chat') {
      stopGeneration();
    } else {
      handleQueue();
    }
  }, [isProcessing, mode, handleSend, stopGeneration, handleQueue]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // ── 命令联想浮层（输入 / 即弹出） ──
      // 触发决策：Enter 在有匹配命令时执行当前项（延续旧行为——输入 /model 回车必弹模型浮层，
      // 绝不可能把命令误发送）；无匹配（如 /tmp/xxx）时不拦截，Enter 正常发送消息。
      // 焦点始终保持在输入框，命令浮层不抢焦点。
      if (cmdOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setCmdIndex((i) => cycleIndex(i, matchedCmds.length, 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setCmdIndex((i) => cycleIndex(i, matchedCmds.length, -1));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && matchedCmds.length > 0) {
          e.preventDefault();
          executeSlashCommand(matchedCmds[Math.min(cmdIndex, matchedCmds.length - 1)]);
          return;
        }
        if (e.key === 'Escape') {
          // 清空输入即关闭联想（输入清除或删除 / 时浮层也自动关闭）
          e.preventDefault();
          setText('');
          return;
        }
      }
      // 模型浮层打开期间：↑/↓ 移动高亮（跳过不可连接项）、Enter 选中、Esc 关闭
      if (pickerOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setPickerIndex((i) => cycleIndex(i, connectable.length, 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setPickerIndex((i) => cycleIndex(i, connectable.length, -1));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const target = connectable[pickerIndex];
          if (target) selectPreset(target.name);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closePicker();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) {
          // 对话模式不排队，Agent 模式可排队
          if (mode === 'agent') handleQueue();
        } else {
          handleSend();
        }
      }
    },
    [isProcessing, mode, handleQueue, handleSend, text, cmdOpen, matchedCmds, cmdIndex, executeSlashCommand, pickerOpen, connectable, pickerIndex, openPicker, selectPreset, closePicker],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, []);

  // ── 粘贴事件 ──
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    const imageItems: DataTransferItem[] = [];
    let textContent = '';

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        imageItems.push(item);
      } else if (item.type === 'text/plain') {
        // 文本类型由浏览器默认处理（直接粘贴到 textarea），不干预
        // 但如果没有图片要处理，就让浏览器正常处理
      }
    }

    if (imageItems.length === 0) return; // 无图片，让浏览器正常粘贴文本

    // 有图片粘贴，阻止默认行为（防止 base64 乱码插入输入框）
    e.preventDefault();

    const newAttachments: ImageAttachment[] = [];

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;

      if (file.size > MAX_IMAGE_SIZE) {
        // 可以加 toast 提示，这里先用 alert
        alert(`图片 "${file.name || '粘贴图片'}" 超过 10MB 限制`);
        continue;
      }

      try {
        const attachment = await readImageAsAttachment(file);
        newAttachments.push(attachment);
      } catch {
        alert('图片读取失败，请重试');
      }
    }

    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.addEventListener('paste', handlePaste as any);
    return () => el.removeEventListener('paste', handlePaste as any);
  }, [handlePaste]);

  // ── 接收 ChatWindow 拖放的文件 ──
  useEffect(() => {
    if (!pendingDropFiles || pendingDropFiles.length === 0) return;
    const files = consumeDropFiles();
    if (!files) return;

    (async () => {
      const newAttachments: ImageAttachment[] = [];
      for (const file of files) {
        if (file.size > MAX_IMAGE_SIZE) {
          alert(`图片 "${file.name}" 超过 10MB 限制`);
          continue;
        }
        try {
          const attachment = await readImageAsAttachment(file);
          newAttachments.push(attachment);
        } catch {
          alert('图片读取失败，请重试');
        }
      }
      if (newAttachments.length > 0) {
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    })();
  }, [pendingDropFiles, consumeDropFiles]);

  // ── 拖放文件 ──
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imageFiles: File[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();
    e.stopPropagation(); // 防止冒泡到 ChatWindow 重复处理
    signalDragClear(); // 通知 ChatWindow 清除遮罩
    const newAttachments: ImageAttachment[] = [];
    for (const file of imageFiles) {
      if (file.size > MAX_IMAGE_SIZE) {
        alert(`图片 "${file.name}" 超过 10MB 限制`);
        continue;
      }
      try {
        const attachment = await readImageAsAttachment(file);
        newAttachments.push(attachment);
      } catch {
        alert('图片读取失败，请重试');
      }
    }
    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  }, []);

  const placeholder = isProcessing
    ? mode === 'chat'
      ? 'AI 正在回复...'
      : 'AI 正在回复... (输入消息将排队发送)'
    : '输入消息... (Enter 发送, Shift+Enter 换行, Ctrl+V 粘贴图片)';

  return (
    <div className="input-bar">
      {/* ── 命令联想浮层（输入 / 立即弹出，样式与 model-picker 统一） ── */}
      {cmdOpen && (
        <>
          {/* 透明遮罩：点击外部关闭（清空输入，与 Esc 行为一致） */}
          <div className="command-picker-overlay" onClick={() => setText('')} />
          <div className="command-picker">
            <div className="command-picker-header">可用命令</div>
            {matchedCmds.length === 0 ? (
              <div className="command-picker-empty">无匹配命令</div>
            ) : (
              <div className="command-picker-list">
                {matchedCmds.map((c, i) => (
                  <div
                    key={c.name}
                    className={`command-picker-item${i === Math.min(cmdIndex, matchedCmds.length - 1) ? ' active' : ''}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    onClick={() => executeSlashCommand(c)}
                  >
                    <span className="command-picker-name">/{c.name}</span>
                    {c.extension && <span className="command-picker-badge">扩展</span>}
                    <span className="command-picker-desc">{c.description}</span>
                    <span className="command-picker-hint">{c.hint}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="command-picker-footer">↑/↓ 选择 · Enter 执行 · Esc 关闭</div>
          </div>
        </>
      )}
      {/* ── 模型选择浮层（/model 命令） ── */}
      {pickerOpen && (
        <>
          {/* 透明遮罩：点击外部关闭 */}
          <div className="model-picker-overlay" onClick={closePicker} />
          <div className="model-picker">
            <div className="model-picker-header">选择默认模型</div>
            {pickerPresets.length === 0 ? (
              <div className="model-picker-empty">暂无模型，请到设置→模型设置添加</div>
            ) : (
              <div className="model-picker-list">
                {pickerPresets.map((p, i) => {
                  const res = pickerResults[p.name];
                  const state = !res ? 'checking' : res.ok ? 'ok' : 'fail';
                  const isDefault = activeNameRef.current === p.name;
                  const isActive = connectable[pickerIndex]?.name === p.name;
                  return (
                    <div
                      key={`${p.name}-${i}`}
                      className={`model-picker-item${isActive ? ' active' : ''}${state !== 'ok' ? ' disabled' : ''}`}
                      onClick={() => { if (state === 'ok') selectPreset(p.name); }}
                    >
                      <div className="model-picker-name-row">
                        <span className="model-picker-model">{p.model}</span>
                        {state === 'ok' && (
                          <span
                            className="model-picker-dot"
                            title={res.latencyMs != null ? `已连接（${res.latencyMs}ms）` : '已连接'}
                          />
                        )}
                        {isDefault && <span className="model-picker-badge">默认使用</span>}
                      </div>
                      <div className="model-picker-meta">
                        {p.name} · {p.baseUrl}
                        {state === 'checking' && <span className="model-picker-checking"> 检测中…</span>}
                        {state === 'fail' && <span className="model-picker-fail"> 不可连接</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="model-picker-hint">↑/↓ 选择 · Enter 确认 · Esc 关闭 · 点击直接切换</div>
          </div>
        </>
      )}
      {pickerTip && <div className="model-picker-tip">{pickerTip}</div>}
      {extTip && <div className="model-picker-tip">{extTip}</div>}

      {/* 附件预览区 */}
      {attachments.length > 0 && (
        <div className="attachment-preview">
          {attachments.map((att, i) => (
            <div key={`${i}-${att.previewUrl?.slice(-20)}`} className="attachment-thumb">
              <img src={att.previewUrl} alt="附件预览" />
              <button
                className="attachment-remove-btn"
                onClick={() => removeAttachment(i)}
                title="移除"
              >
                &#10005;
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="input-bar-inner">
        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            className={`input-textarea${isProcessing ? ' queuing' : ''}`}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onDrop={handleDrop}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer?.types || []).some(t => t === 'Files')) {
                e.preventDefault();
              }
            }}
            placeholder={placeholder}
            rows={1}
          />
          <button
            className={`send-btn${isProcessing ? (mode === 'chat' ? ' stop' : ' queuing') : ''}`}
            onClick={handleButtonClick}
            disabled={!isProcessing && !text.trim() && attachments.length === 0}
            title={isProcessing ? (mode === 'chat' ? '停止' : '排队发送') : '发送'}
          >
            {isProcessing ? (mode === 'chat' ? '■' : '⏎+') : '➤'}
          </button>
        </div>
        {mode === 'agent' && <StopButton />}
      </div>
    </div>
  );
}
