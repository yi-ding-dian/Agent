/**
 * 依赖方向检查（对齐 svn-git 的 check-boundaries）
 *
 * 扫 src/client 下所有相对 import，报告三类违规：
 *
 *   业务域  → 基础层 / 壳             可以
 *   业务域  → 另一个业务域             违规（确有需要应提升到共享层）
 *   基础层  → 业务域                   违规（分层倒置）
 *   业务域  → 壳                       违规（壳是跨域胶水，域不该反向依赖它）
 *
 * 三层划分（见 record.md 的架构改造记录）：
 *   业务域：components/{agent,auth,chat,input,settings}
 *   壳    ：components/layout（AppLayout / Header / Sidebar / SettingsModal 入口）
 *   基础层：components/common（通用 UI）+ services / store / types / utils / hooks / styles
 *
 * 用法：node scripts/check-boundaries.mjs   —— 有违规时退出码 1
 *
 * 注：新增业务域时须在此处 DOMAINS 登记（否则不会被检查）。
 */
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = path.resolve('src/client');

/** 业务域（components/ 下的业务目录） */
const DOMAINS = ['agent', 'auth', 'chat', 'input', 'settings'];
/** 壳（跨域胶水：可引用任意域，但不被域引用） */
const SHELL = ['layout'];
/** 基础层（components/common 是通用 UI；其余为顶层基础设施目录） */
const BASE_TOP = ['services', 'store', 'types', 'utils', 'hooks', 'styles'];
const BASE_COMPONENTS = ['common'];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** 取文件所属的层：返回 { tier, name } */
function layerOf(abs) {
  const segs = path.relative(CLIENT, abs).split(path.sep);
  if (segs[0] === 'components' && segs.length > 1) {
    const sub = segs[1];
    if (DOMAINS.includes(sub)) return { tier: 'domain', name: sub };
    if (SHELL.includes(sub)) return { tier: 'shell', name: sub };
    if (BASE_COMPONENTS.includes(sub)) return { tier: 'base', name: sub };
    return { tier: 'unknown', name: sub };
  }
  if (BASE_TOP.includes(segs[0])) return { tier: 'base', name: segs[0] };
  return { tier: 'unknown', name: segs[0] };
}

const violations = [];
for (const file of walk(CLIENT)) {
  const from = layerOf(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
    const to = layerOf(path.resolve(path.dirname(file), m[1]));
    const rel = path.relative(CLIENT, file);

    if (from.tier === 'base' && to.tier === 'domain') {
      violations.push(`[分层倒置] ${rel}：基础层 ${from.name}/ 引用了业务域 ${to.name}/`);
    } else if (from.tier === 'domain' && to.tier === 'domain' && from.name !== to.name) {
      violations.push(`[跨域引用] ${rel}：${from.name}/ → ${to.name}/`);
    } else if (from.tier === 'domain' && to.tier === 'shell') {
      violations.push(`[域引壳] ${rel}：业务域 ${from.name}/ 引用了壳 ${to.name}/`);
    }
  }
}

if (violations.length === 0) {
  console.log('✅ 依赖方向检查通过：无跨域引用、无分层倒置、无域引壳');
} else {
  console.log(`❌ 发现 ${violations.length} 处违规：`);
  const byKind = {};
  for (const v of violations) (byKind[v.slice(0, 5)] ??= []).push(v);
  for (const [, list] of Object.entries(byKind)) {
    for (const v of list) console.log('  ' + v);
  }
  process.exitCode = 1;
}
