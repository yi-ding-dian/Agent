import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// ─── 类型定义 ────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  filePath: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

// ─── 内部状态 ────────────────────────────────────────────────

let cachedSkills: Skill[] = [];
let skillsBaseDir: string | null = null;

// ─── Frontmatter 解析 ────────────────────────────────────────

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (!normalized.startsWith('---')) {
    return { frontmatter: {}, body: normalized };
  }

  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trimStart();

  try {
    const parsed = parse(yamlString);
    return { frontmatter: (parsed ?? {}) as SkillFrontmatter, body };
  } catch {
    return { frontmatter: {}, body: normalized };
  }
}

// ─── 从单文件加载 skill（可复用：run_skill 工具等） ────────────

/** 解析单个 skill 文件（SKILL.md 或直接 .md），返回 Skill 元信息（含 filePath，供读取完整内容） */
export function parseSkillFile(filePath: string): Skill | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const name = frontmatter.name || path.basename(path.dirname(filePath));
    const description = frontmatter.description;

    if (!description || !description.trim()) {
      console.warn(`[SkillsLoader] 跳过 ${filePath}: 缺少 description`);
      return null;
    }

    return { name, description: description.trim(), filePath };
  } catch (err) {
    console.warn(`[SkillsLoader] 读取失败 ${filePath}:`, err);
    return null;
  }
}

// ─── 目录扫描（可复用：run_skill 工具等） ──────────────────────

/** 扫描目录获取所有 skill（支持 SKILL.md 目录形式与直接 .md 文件形式） */
export function scanSkillsDir(dir: string): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: Skill[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  // 第一遍：检查当前目录是否有 SKILL.md，有则作为单独 skill 不递归
  for (const entry of entries) {
    if (entry.name !== 'SKILL.md') continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const fullPath = path.join(dir, entry.name);
    const skill = parseSkillFile(fullPath);
    if (skill) skills.push(skill);
    return skills; // SKILL.md 模式下不递归
  }

  // 第二遍：直接 .md 文件作为 skills
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const fullPath = path.join(dir, entry.name);
    if (fullPath.endsWith('SKILL.md')) continue; // 已处理过

    const skill = parseSkillFile(fullPath);
    if (skill) skills.push(skill);
  }

  // 第三遍：递归子目录寻找 SKILL.md
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const subDir = path.join(dir, entry.name);
    const subResults = scanSkillsDir(subDir);
    skills.push(...subResults);
  }

  return skills;
}

// ─── 按名称查找 skill（供 run_skill 工具调用） ─────────────────

/**
 * 按名称查找 skill（精确匹配，大小写不敏感）。
 * 先查缓存；未命中时自动 refresh 一次（应对运行时新增的 skill），再未命中返回 null。
 */
export function findSkillByName(name: string): Skill | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  const search = (list: Skill[]): Skill | null =>
    list.find((s) => s.name.trim().toLowerCase() === normalized) || null;

  const hit = search(cachedSkills);
  if (hit) return hit;

  if (skillsBaseDir) {
    const refreshed = refreshSkills();
    return search(refreshed);
  }
  return null;
}

/** 读取 skill 文件的完整 markdown 内容（frontmatter + body） */
export function readSkillContent(skill: Skill): string {
  return fs.readFileSync(skill.filePath, 'utf-8');
}

// ─── Skills 格式化（追加到 system prompt） ────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const lines = [
    '\n\n以下 skills 提供了特定任务的专门指导。',
    '当任务与某个 skill 的描述匹配时，使用 run_skill 工具加载该技能的完整指令内容并按其执行；也可用 read 工具直接读取其文件。',
    '如果 skill 文件中引用了相对路径，请基于 skill 文件所在目录解析为绝对路径后使用。',
    '',
    '<available_skills>',
  ];

  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

// ─── 生命周期管理 ────────────────────────────────────────────

export function initSkillsLoader(projectRoot: string): Skill[] {
  skillsBaseDir = path.resolve(projectRoot, '.pi', 'skills');
  cachedSkills = scanSkillsDir(skillsBaseDir);
  console.log(`[SkillsLoader] 技能目录: ${skillsBaseDir}`);
  console.log(`[SkillsLoader] 发现 ${cachedSkills.length} 个 skills`);
  for (const s of cachedSkills) {
    console.log(`  - ${s.name}: ${s.description}`);
  }
  return cachedSkills;
}

export function refreshSkills(): Skill[] {
  if (!skillsBaseDir) {
    console.warn('[SkillsLoader] 未初始化，跳过刷新');
    return cachedSkills;
  }
  cachedSkills = scanSkillsDir(skillsBaseDir);
  console.log(`[SkillsLoader] 刷新完成: ${cachedSkills.length} 个 skills`);
  return cachedSkills;
}

export function getSkills(): Skill[] {
  return cachedSkills;
}
