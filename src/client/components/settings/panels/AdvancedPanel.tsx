/**
 * 高级设置域（设置 → 高级）
 *
 * 对话压缩 / 子代理 / 跨会话记忆 / 危险命令黑名单 / 网络搜索 的运行参数，
 * 持久化在服务端 data/advanced-config.json。保存走独立端点 api.updateAdvancedConfig。
 *
 * 表单数据（form.advanced）来自设置表单 Provider —— 但保存端点是独立的，
 * 故本域自带保存栏而不复用 shared/SaveFooter。
 */
import { useLayoutEffect, useState } from 'react';
import * as api from '../../../services/api';
import { toast } from '../../../store/toast-store';
import { DEFAULT_ADVANCED_CONFIG } from '../../../../shared/types.js';
import { useSettingsForm } from '../shared/settings-form';

export function AdvancedPanel() {
  const { form, setAdvanced, setAdvancedNested, setFooter } = useSettingsForm();
  const [advSaving, setAdvSaving] = useState(false);

  const adv = form.advanced ?? DEFAULT_ADVANCED_CONFIG;

  const handleSaveAdvanced = async () => {
    setAdvSaving(true);
    try {
      await api.updateAdvancedConfig(adv);
      toast.success('高级设置已保存，立即生效');
    } catch (e: any) {
      toast.error(e.message || '保存失败');
    } finally {
      setAdvSaving(false);
    }
  };

  // 底部保存栏：本域用独立端点保存
  useLayoutEffect(() => {
    setFooter(
      <button
        className="btn btn-primary"
        onClick={() => void handleSaveAdvanced()}
        disabled={advSaving}
      >
        {advSaving ? '保存中...' : '保存'}
      </button>,
    );
    return () => setFooter(null);
    // adv 进 deps：保存需提交最新的表单值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advSaving, adv]);

  return (
    <>
          <div className="settings-section-desc">
            新功能（上下文压缩 / 子代理 / 跨会话记忆 / 危险命令 / 网络搜索）的运行参数，保存在服务端
            data/advanced-config.json，修改后立即生效，无需重启。留空或非法输入会被后端拒绝并提示。
          </div>

          {/* 对话压缩 */}
          <div className="settings-section-title">对话压缩（上下文过长时自动摘要历史）</div>
          <div className="form-group">
            <label>压缩触发阈值 — {Math.round(adv.compaction.threshold * 100)}%</label>
            <input
              type="range"
              min={50}
              max={95}
              step={5}
              value={Math.round(adv.compaction.threshold * 100)}
              onChange={(e) => setAdvancedNested('compaction', 'threshold', parseInt(e.target.value) / 100)}
            />
            <div className="settings-field-hint">
              上下文用量达到该比例时自动压缩（50%-95%）。调低更早压缩、更省 token；调高保留更多上下文。
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>尾部最少保留轮数（{adv.compaction.minTurns} 轮）</label>
              <input
                type="number"
                min={1}
                max={20}
                value={adv.compaction.minTurns}
                onChange={(e) => setAdvancedNested('compaction', 'minTurns', parseInt(e.target.value) || 4)}
              />
              <div className="settings-field-hint">压缩后最近 N 轮对话完整保留，供 Agent 感知最新进展</div>
            </div>
            <div className="form-group">
              <label>摘要辅助模型</label>
              <select
                value={adv.summaryModel}
                onChange={(e) => setAdvanced({ summaryModel: e.target.value as 'auto' | 'main' })}
              >
                <option value="auto">自动（优先 DeepSeek，失败回退主模型）</option>
                <option value="main">主模型（使用当前对话模型生成摘要）</option>
              </select>
              <div className="settings-field-hint">auto 时若配置了 DEEPSEEK_API_KEY 则用 DeepSeek 生成摘要，更省主模型额度</div>
            </div>
          </div>

          {/* 子代理 */}
          <hr className="settings-divider" />
          <div className="settings-section-title">子代理（subagent 工具）</div>
          <div className="form-row">
            <div className="form-group">
              <label>最大轮数（{adv.subagent.maxTurns} 轮）</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={adv.subagent.maxTurns}
                onChange={(e) => setAdvancedNested('subagent', 'maxTurns', parseInt(e.target.value) || 50)}
              />
              <div className="settings-field-hint">子代理最多执行多少轮（LLM 调用次数），1-1000，防止子任务失控</div>
            </div>
            <div className="form-group">
              <label>超时时间（{Math.round(adv.subagent.timeoutMs / 1000)} 秒）</label>
              <input
                type="number"
                min={1}
                max={3600}
                value={Math.round(adv.subagent.timeoutMs / 1000)}
                onChange={(e) => setAdvancedNested('subagent', 'timeoutMs', (parseInt(e.target.value) || 1800) * 1000)}
              />
              <div className="settings-field-hint">子代理整体超时（秒），1-3600，超时自动中止并返回已有结果</div>
            </div>
            <div className="form-group">
              <label>最大并发数（{adv.subagent.maxConcurrent} 个）</label>
              <input
                type="number"
                min={1}
                max={20}
                value={adv.subagent.maxConcurrent}
                onChange={(e) => setAdvancedNested('subagent', 'maxConcurrent', parseInt(e.target.value) || 5)}
              />
              <div className="settings-field-hint">同一会话同时运行的子代理数上限，1-20。主代理一次派多个子代理会并行执行，此项仅防失控</div>
            </div>
          </div>

          {/* 记忆 */}
          <hr className="settings-divider" />
          <div className="settings-section-title">跨会话记忆</div>
          <div className="form-row">
            <div className="form-group">
              <label>最大条目数（{adv.memory.maxEntries} 条）</label>
              <input
                type="number"
                min={50}
                max={5000}
                step={10}
                value={adv.memory.maxEntries}
                onChange={(e) => setAdvancedNested('memory', 'maxEntries', parseInt(e.target.value) || 500)}
              />
              <div className="settings-field-hint">记忆条数超过上限时自动删除最旧条目，防止文件无限膨胀</div>
            </div>
            <div className="form-group">
              <label>单条长度上限（{adv.memory.maxNoteLength} 字符）</label>
              <input
                type="number"
                min={100}
                max={10000}
                step={100}
                value={adv.memory.maxNoteLength}
                onChange={(e) => setAdvancedNested('memory', 'maxNoteLength', parseInt(e.target.value) || 2000)}
              />
              <div className="settings-field-hint">Agent 调用记住（remember）工具时的单条内容长度限制</div>
            </div>
          </div>

          {/* 危险命令 */}
          <hr className="settings-divider" />
          <div className="settings-section-title">危险命令黑名单</div>
          <div className="form-group">
            <textarea
              rows={5}
              value={(adv.commandBlacklist ?? []).join('\n')}
              onChange={(e) =>
                setAdvanced({
                  commandBlacklist: e.target.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder={'sudo\nmkfs\ndd\nrm -rf /'}
              style={{ fontFamily: 'monospace' }}
            />
            <div className="settings-field-hint">
              一行一个命令（如 sudo、rm -rf /）。代码内置底线保护（sudo/mkfs/dd 等）始终生效、无法移除，
              这里只增不减；保存后立即阻止所有匹配该命令开头的执行请求。
            </div>
          </div>

          {/* 网络搜索 */}
          <hr className="settings-divider" />
          <div className="settings-section-title">网络搜索</div>
          <div className="form-row">
            <div className="form-group">
              <label>超时时间（{Math.round(adv.search.timeoutMs / 1000)} 秒）</label>
              <input
                type="number"
                min={1}
                max={600}
                value={Math.round(adv.search.timeoutMs / 1000)}
                onChange={(e) => setAdvancedNested('search', 'timeoutMs', (parseInt(e.target.value) || 15) * 1000)}
              />
              <div className="settings-field-hint">单次搜索请求的最大等待时间（秒）</div>
            </div>
            <div className="form-group">
              <label>最大结果数（{adv.search.maxResults} 条）</label>
              <input
                type="number"
                min={1}
                max={20}
                value={adv.search.maxResults}
                onChange={(e) => setAdvancedNested('search', 'maxResults', parseInt(e.target.value) || 8)}
              />
              <div className="settings-field-hint">Agent 搜索时默认返回的结果条数</div>
            </div>
          </div>
    </>
  );
}
