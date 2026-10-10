import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import { getAdvancedConfig } from '../config/advanced-config.js';

/** 默认值（advanced-config.json 的 search 段，可运行时调整） */
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;

const SearchWebParams = Type.Object({
  query: Type.String({ description: '搜索关键词' }),
  count: Type.Optional(Type.Number({ description: '返回结果数量', default: 8 })),
});

export type SearchWebParams = Static<typeof SearchWebParams>;

export function createSearchWebTool(): AgentTool<typeof SearchWebParams> {
  return {
    name: 'search_web',
    label: 'Search Web',
    description: '使用 DuckDuckGo 搜索引擎搜索网络信息',
    parameters: SearchWebParams,
    async execute(
      _toolCallId: string,
      params: SearchWebParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // 每次执行读取配置（advanced-config.search，默认 8 条 / 15s 超时），运行时修改立即生效
      const searchCfg = getAdvancedConfig().search;
      const count = params.count ?? searchCfg.maxResults ?? DEFAULT_MAX_RESULTS;
      const timeoutMs = searchCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        const results = await searchDuckDuckGo(params.query, count, timeoutMs);
        const text = formatResults(params.query, results);
        return {
          content: [{ type: 'text', text }],
          details: { query: params.query, resultCount: results.length, results },
        };
      } catch (err: any) {
        throw new Error(`搜索失败: ${err.message}`);
      }
    },
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string, maxResults: number, timeoutMs: number): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const html = await resp.text();
    return parseDuckDuckGoResults(html, maxResults);
  } finally {
    clearTimeout(timeout);
  }
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // 解析 DuckDuckGo Lite 结果页面
  // 格式: <a rel="nofollow" href="URL" class="result-link">TITLE</a>
  //       <span class="result-snippet">SNIPPET</span>

  const resultRegex = /<a[^>]*href="?(https?:\/\/[^"\s]+)"?[^>]*class="result-link"[^>]*>([^<]+)<\/a>\s*<span[^>]*class="result-snippet"[^>]*>([^<]*)<\/span>/gi;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    const url = match[1];
    const title = decodeHtmlEntities(match[2].trim());
    const snippet = decodeHtmlEntities(match[3].trim());
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  // 备用：更宽松的解析
  if (results.length === 0) {
    const linkRegex = /<a[^>]*href="?(https?:\/\/[^"\s]+)"?[^>]*class="[^"]*result[^"]*"[^>]*>([^<]+)<\/a>/gi;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

    const links: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];

    let m;
    while ((m = linkRegex.exec(html)) !== null && links.length < maxResults) {
      links.push({ url: m[1], title: decodeHtmlEntities(m[2].trim()) });
    }
    while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
      snippets.push(decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()));
    }

    for (let i = 0; i < Math.min(links.length, maxResults); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] || '',
      });
    }
  }

  return results;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, ' ');
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `搜索 "${query}" 未找到结果。`;
  }
  const lines: string[] = [
    `搜索 "${query}" 的结果：`,
    '',
  ];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) {
      lines.push(`   ${r.snippet}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}
