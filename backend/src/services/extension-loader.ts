/**
 * Pi 扩展加载器
 *
 * 启动时扫描扩展目录，动态加载 Pi 扩展模块：
 *  - 通道 1（npm 包）：<dataDir>/../extensions/node_modules 中带 pi.extensions manifest 的包
 *  - 通道 2（目录扩展）：<projectRoot>/.pi/extensions 下每个子目录（与 skillsDir 的 .pi/skills 约定一致），
 *    子目录含 package.json（pi.extensions manifest）或直接 .ts/.js 入口文件即视为扩展
 *
 * 加载方式：.ts 扩展用 tsx 的程序化 API tsImport（解决部署版 node 原生类型剥离失败
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）；.js 扩展保留普通 dynamic import 路径。
 * 扩展模块需 export default (api: ExtensionAPI) => void 作为入口。
 *
 * 扩展能力（对齐 pi coding-agent 接口设计，只取本系统所需子集）：
 *  - registerTool()      注册 LLM 可调用工具（合并进 Agent 工具列表）
 *  - registerCommand()   注册自定义命令（前端 / 命令列表合并；POST /api/extensions/:name/command 执行）
 *  - on('input' | 'before_provider_request' | 'tool_call' | 'tool_result', handler)
 *                        注册事件钩子（挂点见各调用处；钩子异常一律 try-catch 不中断主流程）
 *  - sendMessage()       兼容占位（静默，UI 能力不在本系统范围内）
 *
 * 启停管理：data/extensions-state.json 记录 { [name]: 'enabled' | 'disabled' }（仿 advanced-config 模式）；
 * disabled 的扩展不加载工具/命令、不触发钩子（发现但未启用的扩展仍在 GET /api/extensions 中列出）。
 * 切换后即时生效：新建会话（buildTools 调 getExtensionTools）/ 命令列表 / 钩子分发时按状态过滤；
 * 运行中的会话不热更新（已创建的工具数组不变），需新会话生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { config } from '../config.js';

// ─── 类型定义 ──────────────────────────────────────────────

/** 扩展注册的工具定义（与 pi-coding-agent 的 ToolDefinition 形状兼容） */
interface ExtensionToolDef {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  executionMode?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}

/** 命令 handler 的上下文 */
export interface ExtensionCommandContext {
  cwd: string;
  /** 发起命令的会话 ID（可缺省） */
  sessionId?: string;
  /** 命令所属扩展名 */
  extensionName: string;
}

/** 扩展命令定义（registerCommand 注册项） */
export interface ExtensionCommandDef {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<string | void> | string | void;
  extensionName: string;
}

/** 事件钩子通用上下文 */
export interface ExtensionHookContext {
  cwd: string;
  sessionId?: string;
}

/** input 钩子返回：返回字符串或 { action: 'transform' } 替换用户消息文本；undefined 保持原样 */
export type InputHookResult = string | { action: 'transform'; text: string } | undefined;

/** tool_call 钩子返回：block=true 拦截该工具调用（优先于权限系统） */
export interface ToolCallHookResult {
  block?: boolean;
  reason?: string;
}

/** tool_result 钩子返回：patch 工具执行结果（content/isError 均缺省则视为未修改） */
export interface ToolResultHookResult {
  content?: unknown;
  isError?: boolean;
}

/** 扩展来源：npm=extensions/node_modules 中的包；dir=.pi/extensions 下的目录扩展 */
export type ExtensionSource = 'npm' | 'dir';

/** 扩展元信息（GET /api/extensions 返回；含发现但未启用的扩展） */
export interface ExtensionInfo {
  name: string;
  description: string;
  source: ExtensionSource;
  enabled: boolean;
  toolCount: number;
  commandCount: number;
}

/** 已加载扩展的内部表示 */
interface LoadedExtension {
  name: string;
  description: string;
  source: ExtensionSource;
  dir: string;
  tools: AgentTool<any>[];
  commands: ExtensionCommandDef[];
  inputHandlers: Array<(event: { text: string }, ctx: ExtensionHookContext) => InputHookResult | Promise<InputHookResult>>;
  beforeProviderRequestHandlers: Array<
    (opts: Record<string, unknown>, ctx: ExtensionHookContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>
  >;
  toolCallHandlers: Array<
    (event: { toolName: string; toolCallId?: string; input: unknown }, ctx: ExtensionHookContext) => ToolCallHookResult | void | Promise<ToolCallHookResult | void>
  >;
  toolResultHandlers: Array<
    (event: { toolName: string; toolCallId?: string; result: unknown; isError: boolean }, ctx: ExtensionHookContext) => ToolResultHookResult | void | Promise<ToolResultHookResult | void>
  >;
}

/** 最小 ExtensionAPI，扩展工厂函数接收此对象（对齐 pi 的 pi.* 接口命名） */
export interface ExtensionAPI {
  registerTool(tool: ExtensionToolDef): void;
  registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => unknown }): void;
  on(
    event: 'input' | 'before_provider_request' | 'tool_call' | 'tool_result',
    handler: (...args: unknown[]) => unknown,
  ): void;
  sendMessage?: (msg: unknown, opts?: unknown) => void;
}

// ─── 内部状态 ──────────────────────────────────────────────

/** 全部发现（含未加载/未启用）的扩展元信息，用于管理列表 */
let discoveredExtensions: ExtensionInfo[] = [];
/** 已成功加载的扩展（含 disabled —— 运行时按状态过滤，支持 toggle 即时生效） */
let loadedExtensions: LoadedExtension[] = [];

// ─── 启停状态（data/extensions-state.json，仿 advanced-config 模式） ──

interface ExtensionsState {
  [name: string]: 'enabled' | 'disabled';
}

function getStateFilePath(): string {
  return path.resolve(config.dataDir, 'extensions-state.json');
}

function saveStateToFile(state: ExtensionsState): void {
  try {
    const filePath = getStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[ExtensionLoader] 状态保存失败: ${err}`);
  }
}

let currentState: ExtensionsState | null = null;

/** 懒加载扩展状态（文件缺失/损坏回退空对象，不抛错不阻断） */
function loadState(): ExtensionsState {
  if (currentState) return currentState;
  try {
    const filePath = getStateFilePath();
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      currentState =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as ExtensionsState)
          : {};
    } else {
      currentState = {};
    }
  } catch (err) {
    console.error(`[ExtensionLoader] 状态加载失败，按全部启用处理: ${err}`);
    currentState = {};
  }
  return currentState;
}

/** 扩展是否启用（缺省 enabled；文件中的 disabled 才视为停用） */
export function isExtensionEnabled(name: string): boolean {
  return loadState()[name] !== 'disabled';
}

/** 切换扩展启停（落盘 extensions-state.json；新会话/命令列表/钩子分发即时生效，运行中会话不热更新） */
export function setExtensionEnabled(name: string, enabled: boolean): void {
  const state = loadState();
  if (enabled) {
    delete state[name];
  } else {
    state[name] = 'disabled';
  }
  currentState = state;
  saveStateToFile(state);
  console.log(`[ExtensionLoader] 扩展「${name}」已${enabled ? '启用' : '停用'}（新会话/命令生效，运行中会话不热更新）`);
}

// ─── 扩展发现 ──────────────────────────────────────────────

interface DiscoveredExtension {
  name: string;
  description: string;
  source: ExtensionSource;
  dir: string;
  entryFiles: string[];
}

/**
 * 通道 1：扫描 extensions/node_modules，找出包含 pi.extensions 配置的包
 */
function discoverNpmExtensions(extensionsDir: string): DiscoveredExtension[] {
  const results: DiscoveredExtension[] = [];
  const nmDir = path.join(extensionsDir, 'node_modules');
  if (!fs.existsSync(nmDir)) return results;

  const entries = fs.readdirSync(nmDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const pkgDirs: string[] = [];
    if (entry.name.startsWith('@')) {
      // scoped 包: @scope/name
      const scopeDir = path.join(nmDir, entry.name);
      if (!fs.existsSync(scopeDir)) continue;
      const subs = fs.readdirSync(scopeDir, { withFileTypes: true });
      for (const sub of subs) {
        if (sub.isDirectory() || sub.isSymbolicLink()) pkgDirs.push(path.join(scopeDir, sub.name));
      }
    } else {
      pkgDirs.push(path.join(nmDir, entry.name));
    }

    for (const pkgDir of pkgDirs) {
      const pkgPath = path.join(pkgDir, 'package.json');
      const manifest = readManifest(pkgPath);
      if (!manifest || !manifest.pi?.extensions?.length) continue;
      results.push({
        name: manifest.name || path.basename(pkgDir),
        description: manifest.description || '',
        source: 'npm',
        dir: pkgDir,
        entryFiles: manifest.pi.extensions.map((rel: string) => path.resolve(pkgDir, rel)),
      });
    }
  }

  return results;
}

/**
 * 通道 2：扫描 <projectRoot>/.pi/extensions 下每个子目录
 * 子目录含 package.json（pi.extensions manifest）或直接 .ts/.js 入口文件的都算扩展
 */
function discoverDirExtensions(projectRoot: string): DiscoveredExtension[] {
  const results: DiscoveredExtension[] = [];
  const extDir = path.resolve(projectRoot, '.pi', 'extensions');
  if (!fs.existsSync(extDir)) return results;

  const entries = fs.readdirSync(extDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const dir = path.join(extDir, entry.name);
    const pkgPath = path.join(dir, 'package.json');
    const manifest = readManifest(pkgPath);

    let name = manifest?.name || entry.name;
    let entryFiles: string[] = [];

    if (manifest?.pi?.extensions?.length) {
      entryFiles = manifest.pi.extensions.map((rel: string) => path.resolve(dir, rel));
    } else {
      // 无 manifest：找 index.ts/index.js，否则目录顶层唯一的 .ts/.js 文件
      const candidates = ['index.ts', 'index.js', 'index.mjs', 'index.cjs'];
      for (const c of candidates) {
        const f = path.join(dir, c);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
          entryFiles.push(f);
          break;
        }
      }
      if (entryFiles.length === 0) {
        const files = fs
          .readdirSync(dir)
          .filter((f) => /\.(ts|js|mjs|cjs)$/.test(f) && fs.statSync(path.join(dir, f)).isFile());
        if (files.length === 1) {
          entryFiles.push(path.join(dir, files[0]));
        } else if (files.length > 1) {
          console.warn(`[ExtensionLoader] 跳过 ${entry.name}: 无 index 入口且顶层存在多个 .ts/.js 文件（${files.join(', ')}）`);
          continue;
        }
      }
    }

    if (entryFiles.length === 0) {
      console.warn(`[ExtensionLoader] 跳过 ${entry.name}: 未找到扩展入口（无 package.json pi.extensions，也无 index.* / .ts/.js 入口）`);
      continue;
    }

    results.push({
      name,
      description: manifest?.description || '',
      source: 'dir',
      dir,
      entryFiles: entryFiles.filter((f) => fs.existsSync(f)),
    });
  }

  return results;
}

function readManifest(pkgPath: string): { name?: string; description?: string; pi?: { extensions?: string[] } } | null {
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string; description?: string; pi?: { extensions?: string[] } };
  } catch {
    return null;
  }
}

// ─── 工具包装 ──────────────────────────────────────────────

/**
 * 将 ExtensionToolDef 包装为 AgentTool
 *
 * AgentTool.execute 签名为 (toolCallId, params, signal, onUpdate)
 * ExtensionToolDef.execute 的签名为 (toolCallId, params, signal, onUpdate, ctx)
 * 此处通过 ctxFactory 注入最小上下文（至少提供 cwd）
 */
function wrapToAgentTool(
  def: ExtensionToolDef,
  ctxFactory: () => { cwd: string },
): AgentTool<any> {
  return {
    name: def.name,
    label: def.label || def.name,
    description: def.description || '',
    parameters: def.parameters,
    prepareArguments: def.prepareArguments,
    executionMode: def.executionMode as any,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // 扩展工具执行签名多 ctx 参数；onUpdate 参数类型（AgentToolResult vs unknown）不同，
      // 透传前包装；返回结构扩展工具承诺与 AgentToolResult 兼容，直接断言
      return def.execute(
        toolCallId,
        params,
        signal,
        onUpdate ? (update: unknown) => onUpdate(update as AgentToolResult<any>) : undefined,
        ctxFactory(),
      ) as Promise<AgentToolResult<any>>;
    },
  };
}

// ─── 扩展模块加载器 ─────────────────────────────────────────

export type ExtensionModuleLoader = (fileUrl: string) => Promise<{ default?: unknown; [key: string]: unknown }>;

/**
 * 默认加载器：.ts 扩展走 tsImport（tsx 程序化 API，支持 node_modules 下 .ts，
 * 修复部署版 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）；.js 扩展保留普通 import。
 * 外部（Electron 引擎）可注入自定义 loader（如固定 tsImport 的 agent-engine）。
 */
const defaultLoader: ExtensionModuleLoader = async (fileUrl) => {
  if (fileURLToPath(fileUrl).endsWith('.ts')) {
    const { tsImport } = await import('tsx/esm/api');
    return tsImport(fileURLToPath(fileUrl), import.meta.url);
  }
  return import(fileUrl);
};

// ─── 钩子分发（异常一律 try-catch，不中断主流程） ─────────────

function makeHookCtx(sessionId?: string): ExtensionHookContext {
  return { cwd: config?.workDir || process.cwd(), sessionId };
}

/**
 * input 钩子：用户消息发送前可转换。
 * 挂点：chat.routes / execute.routes / ws-server 收到 message 后、进 agent 前。
 * 多个扩展按注册顺序链式变换（后者作用于前者结果）；钩子异常跳过该钩子继续。
 */
export async function runInputHooks(text: string, sessionId?: string): Promise<string> {
  let current = text;
  const ctx = makeHookCtx(sessionId);
  for (const ext of loadedExtensions) {
    if (!isExtensionEnabled(ext.name)) continue;
    for (const handler of ext.inputHandlers) {
      try {
        const result = await handler({ text: current }, ctx);
        if (typeof result === 'string') {
          current = result;
        } else if (result && result.action === 'transform') {
          current = result.text;
        }
      } catch (err) {
        console.warn(`[ExtensionLoader] input 钩子异常（${ext.name}），跳过:`, err);
      }
    }
  }
  return current;
}

/**
 * before_provider_request 钩子：LLM 请求发出前可修改参数。
 * 挂点：agent-factory streamFn 的 enhancedOpts 构造后、streamSimple 调用前。
 * handler 可原地修改 opts 或返回对象（浅合并进最终请求参数）。
 */
export async function runBeforeProviderRequestHooks(
  opts: Record<string, unknown>,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  let merged = { ...opts };
  const ctx = makeHookCtx(sessionId);
  for (const ext of loadedExtensions) {
    if (!isExtensionEnabled(ext.name)) continue;
    for (const handler of ext.beforeProviderRequestHandlers) {
      try {
        const result = await handler(merged, ctx);
        if (result && typeof result === 'object') {
          merged = { ...merged, ...result };
        }
      } catch (err) {
        console.warn(`[ExtensionLoader] before_provider_request 钩子异常（${ext.name}），跳过:`, err);
      }
    }
  }
  return merged;
}

/**
 * tool_call 钩子：工具调用前拦截，返回 { block?: boolean, reason? }。
 * 挂点：agent-factory beforeToolCall 最前面，block 优先于权限系统。
 * 多个扩展中任一 block 即拦截（后续钩子不再执行）。
 */
export async function runToolCallHooks(
  toolCall: { toolName: string; toolCallId?: string; input: unknown },
  sessionId?: string,
): Promise<ToolCallHookResult | undefined> {
  const ctx = makeHookCtx(sessionId);
  for (const ext of loadedExtensions) {
    if (!isExtensionEnabled(ext.name)) continue;
    for (const handler of ext.toolCallHandlers) {
      try {
        const result = await handler(toolCall, ctx);
        if (result && result.block) {
          console.log(`[ExtensionLoader] 工具 ${toolCall.toolName} 被扩展「${ext.name}」拦截: ${result.reason || '(无原因)'}`);
          return result;
        }
      } catch (err) {
        console.warn(`[ExtensionLoader] tool_call 钩子异常（${ext.name}），跳过:`, err);
      }
    }
  }
  return undefined;
}

/**
 * tool_result 钩子：工具执行结果回传处可 patch（content / isError）。
 * 挂点：agent-service 事件流 tool_execution_end（pi-agent-core 按序 await listener，顺序安全）。
 * 多个扩展的返回浅合并（content/isError 后者覆盖）。
 */
export async function runToolResultHooks(
  result: { toolName: string; toolCallId?: string; result: unknown; isError: boolean },
  sessionId?: string,
): Promise<ToolResultHookResult | undefined> {
  let patch: ToolResultHookResult | undefined;
  const ctx = makeHookCtx(sessionId);
  for (const ext of loadedExtensions) {
    if (!isExtensionEnabled(ext.name)) continue;
    for (const handler of ext.toolResultHandlers) {
      try {
        const result2 = await handler(result, ctx);
        if (result2 && (result2.content !== undefined || result2.isError !== undefined)) {
          patch = { ...patch, ...result2 };
        }
      } catch (err) {
        console.warn(`[ExtensionLoader] tool_result 钩子异常（${ext.name}），跳过:`, err);
      }
    }
  }
  return patch;
}

// ─── 扩展命令 ──────────────────────────────────────────────

/**
 * 获取已加载扩展注册的命令（enabled 过滤）。
 * 前端挂载时拉取合并进 / 命令列表（GET /api/extensions/commands）。
 */
export function getExtensionCommands(): ExtensionCommandDef[] {
  const out: ExtensionCommandDef[] = [];
  for (const ext of loadedExtensions) {
    if (!isExtensionEnabled(ext.name)) continue;
    out.push(...ext.commands);
  }
  return out;
}

/**
 * 执行扩展命令（POST /api/extensions/:name/command 调用）。
 * handler 返回的文本作为结果回传前端展示（前端作为用户消息发送给当前会话）。
 */
export async function runExtensionCommand(
  name: string,
  args: string,
  sessionId?: string,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const cmd = getExtensionCommands().find((c) => c.name === name);
  if (!cmd) return { ok: false, error: `扩展命令不存在: /${name}` };
  try {
    const result = await cmd.handler(args, {
      cwd: config?.workDir || process.cwd(),
      sessionId,
      extensionName: cmd.extensionName,
    });
    return { ok: true, result: typeof result === 'string' ? result : '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ExtensionLoader] 扩展命令 /${name} 执行失败:`, err);
    return { ok: false, error: msg };
  }
}

// ─── 扩展注册表 ────────────────────────────────────────────

/** 获取扩展列表（GET /api/extensions；含发现但未启用的扩展） */
export function getExtensionRegistry(): ExtensionInfo[] {
  return discoveredExtensions.map((d) => {
    const loaded = loadedExtensions.find((e) => e.name === d.name);
    const enabled = isExtensionEnabled(d.name);
    return {
      name: d.name,
      description: d.description,
      source: d.source,
      enabled,
      toolCount: enabled && loaded ? loaded.tools.length : 0,
      commandCount: enabled && loaded ? loaded.commands.length : 0,
    };
  });
}

// ─── 公开 API ──────────────────────────────────────────────

/**
 * 初始化扩展加载器，双通道扫描并加载所有启用的扩展
 *
 * 应在服务启动时调用一次（后端 index.ts 中）。
 */
export async function initExtensionLoader(extensionsDir: string, loader?: ExtensionModuleLoader): Promise<void> {
  const startTime = Date.now();
  const workDir = config?.workDir || process.cwd();
  const ctxFactory = () => ({ cwd: workDir });
  const effectiveLoader = loader ?? defaultLoader;

  // 1. 发现（npm 通道 + 目录通道；同名冲突：后发现的跳过并警告）
  const projectRoot = path.resolve(extensionsDir, '..');
  const discovered = [...discoverNpmExtensions(extensionsDir), ...discoverDirExtensions(projectRoot)];
  const seenNames = new Set<string>();
  const deduped: DiscoveredExtension[] = [];
  for (const d of discovered) {
    if (seenNames.has(d.name)) {
      console.warn(`[ExtensionLoader] 扩展重名「${d.name}」（${d.source}），跳过 ${d.dir}`);
      continue;
    }
    seenNames.add(d.name);
    deduped.push(d);
  }
  discoveredExtensions = deduped.map((d) => ({
    name: d.name,
    description: d.description,
    source: d.source,
    enabled: isExtensionEnabled(d.name),
    toolCount: 0,
    commandCount: 0,
  }));

  if (deduped.length === 0) {
    console.log('[ExtensionLoader] 未发现扩展');
    loadedExtensions = [];
    return;
  }

  const errors: string[] = [];

  // 2. 逐个加载（disabled 的扩展也加载进内存，但工具/命令/钩子分发时按状态过滤 ——
  //    这样 toggle enable 后无需重启即可恢复；单个失败跳过并警告，不影响其他扩展）
  for (const d of deduped) {
    const ext: LoadedExtension = {
      name: d.name,
      description: d.description,
      source: d.source,
      dir: d.dir,
      tools: [],
      commands: [],
      inputHandlers: [],
      beforeProviderRequestHandlers: [],
      toolCallHandlers: [],
      toolResultHandlers: [],
    };

    for (const entryFile of d.entryFiles) {
      try {
        const mod = await effectiveLoader(pathToFileURL(entryFile).href);
        const factory: unknown = mod.default || mod;

        if (typeof factory !== 'function') {
          errors.push(`${d.name}/${path.basename(entryFile)}: 默认导出不是函数`);
          continue;
        }

        const commandNames = new Set<string>();
        const api: ExtensionAPI = {
          registerTool(tool: ExtensionToolDef) {
            ext.tools.push(wrapToAgentTool(tool, ctxFactory));
          },
          registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => unknown }) {
            if (typeof name !== 'string' || !name.trim() || typeof opts?.handler !== 'function') {
              console.warn(`[ExtensionLoader] 扩展「${d.name}」registerCommand 参数非法，忽略`);
              return;
            }
            if (commandNames.has(name)) {
              console.warn(`[ExtensionLoader] 扩展「${d.name}」重复注册命令 /${name}，后者覆盖`);
            }
            commandNames.add(name);
            ext.commands.push({
              name,
              description: opts.description || '',
              handler: opts.handler as ExtensionCommandDef['handler'],
              extensionName: d.name,
            });
          },
          on(event: string, handler: (...args: unknown[]) => unknown) {
            if (typeof handler !== 'function') {
              console.warn(`[ExtensionLoader] 扩展「${d.name}」on(${event}) handler 不是函数，忽略`);
              return;
            }
            switch (event) {
              case 'input':
                ext.inputHandlers.push(handler as LoadedExtension['inputHandlers'][number]);
                break;
              case 'before_provider_request':
                ext.beforeProviderRequestHandlers.push(handler as LoadedExtension['beforeProviderRequestHandlers'][number]);
                break;
              case 'tool_call':
                ext.toolCallHandlers.push(handler as LoadedExtension['toolCallHandlers'][number]);
                break;
              case 'tool_result':
                ext.toolResultHandlers.push(handler as LoadedExtension['toolResultHandlers'][number]);
                break;
              default:
                console.warn(`[ExtensionLoader] 扩展「${d.name}」注册未知事件钩子: ${event}（当前支持 input/before_provider_request/tool_call/tool_result）`);
            }
          },
          // 兼容占位：sendMessage 面向 pi TUI 的 UI 能力，本系统不提供，静默忽略
          sendMessage: () => {},
        };

        await (factory as (api: ExtensionAPI) => void | Promise<void>)(api);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${d.name}/${path.basename(entryFile)}: ${msg}`);
        console.error(`[ExtensionLoader] 扩展「${d.name}」加载失败: ${msg}`);
      }
    }

    loadedExtensions.push(ext);
    if (!isExtensionEnabled(d.name)) {
      console.log(`[ExtensionLoader] 扩展「${d.name}」已停用，加载但暂不生效`);
    }
    for (const t of ext.tools) {
      console.log(`[ExtensionLoader] + ${t.name} ← ${d.name} (${d.source})`);
    }
    for (const c of ext.commands) {
      console.log(`[ExtensionLoader] + /${c.name} 命令 ← ${d.name} (${d.source})`);
    }
  }

  if (errors.length > 0) {
    console.warn(`[ExtensionLoader] 完成，${errors.length} 个错误`);
    for (const e of errors) console.warn(`  - ${e}`);
  }
  const toolCount = loadedExtensions.reduce((n, e) => n + e.tools.length, 0);
  const cmdCount = loadedExtensions.reduce((n, e) => n + e.commands.length, 0);
  console.log(`[ExtensionLoader] 已加载 ${loadedExtensions.length} 个扩展（${toolCount} 工具 / ${cmdCount} 命令）(${Date.now() - startTime}ms)`);
}

/**
 * 获取所有已加载且启用的扩展工具
 *
 * 在 AgentSession 创建时与静态工具合并（session-manager.buildTools 调用）；
 * toggle 停用后，新建会话的工具列表即不再包含该扩展工具（运行中会话不热更新）。
 */
export function getExtensionTools(): AgentTool<any>[] {
  const out: AgentTool<any>[] = [];
  for (const ext of loadedExtensions) {
    if (!isExtensionEnabled(ext.name)) continue;
    out.push(...ext.tools);
  }
  return out;
}
