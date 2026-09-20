import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Pencil, Plus, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { errorText } from '../../../src/ui'
import { ProviderEditor } from './Dialogs'
import { assignmentImportService } from './service'
import type { ModuleConfig, ProviderInput } from './types'
import providerPresets from '../provider-presets.json'
import manifest from '../module.json'

const blankProvider: ProviderInput = {
  id: '', name: '', kind: 'bailian', base_url: providerPresets.bailian.base_url, model: providerPresets.bailian.model, has_key: false, api_key: '',
}

export function SettingsCard({ enabled, onToggle }: { enabled: boolean; onToggle: (enabled: boolean) => void }) {
  const [config, setConfig] = useState<ModuleConfig | null>(null)
  const [editor, setEditor] = useState<ProviderInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => setConfig(await assignmentImportService.config()), [])
  useEffect(() => { if (enabled) void refresh().catch(e => setMessage(errorText(e))) }, [enabled, refresh])
  const execute = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setMessage('')
    try { await work(); await refresh(); setMessage(success); return true }
    catch (e) { setMessage(errorText(e)); return false }
    finally { setBusy(false) }
  }
  const remove = (id: string) => {
    if (window.confirm('确定删除此 AI 服务商吗？保存的密钥也会删除。')) void execute(() => assignmentImportService.deleteProvider(id), '服务商已删除')
  }
  return <section className="settings-card module-settings-card" data-module={manifest.id}>
    <div className="settings-card-title"><div><h2><Sparkles size={18} />AI 作业导入</h2><p>识别一份公告中的多项作业，并在保存前逐条审核。仅在点击识别时发送本次内容。</p></div><div className="module-card-actions"><button className={`module-toggle ${enabled ? 'enabled' : ''}`} role="switch" aria-checked={enabled} onClick={() => onToggle(!enabled)}><span />{enabled ? '已开启' : '已关闭'}</button>{enabled ? <button className="button button-quiet" onClick={() => setEditor({ ...blankProvider })}><Plus size={16} />添加服务商</button> : null}</div></div>
    {!enabled ? <div className="module-disabled-message">模块已关闭。作业数据和模块配置仍会保留，重新开启后可继续使用。</div> : null}
    {enabled ? <>
    <div className="module-settings-section"><h3>服务商与模型</h3>{config?.providers.map(provider => <div className="provider-row" key={provider.id}><div className="provider-icon"><Sparkles size={19} /></div><div><strong>{provider.name}</strong><small>{provider.model} · {provider.has_key ? '密钥已保存' : '未保存密钥'}</small></div><button className="icon-button" onClick={() => setEditor({ ...provider, api_key: '' })} title="编辑"><Pencil size={16} /></button><button className="icon-button danger-hover" onClick={() => remove(provider.id)} title="删除"><Trash2 size={16} /></button></div>)}{config && !config.providers.length ? <div className="settings-empty">尚未配置服务商。手动录入和文件管理可照常使用。</div> : null}</div>
    <div className="module-settings-section"><h3>功能使用的模型</h3><div className="form-grid"><label className="form-field">作业识别使用<select value={config?.assignment_provider_id || ''} onChange={e => setConfig(current => current ? { ...current, assignment_provider_id:e.target.value } : current)}><option value="">未指定</option>{config?.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name} · {provider.model}</option>)}</select></label><label className="form-field">教材匹配使用 <small>未来功能</small><select value={config?.material_provider_id || ''} onChange={e => setConfig(current => current ? { ...current, material_provider_id:e.target.value } : current)}><option value="">未指定</option>{config?.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name} · {provider.model}</option>)}</select></label></div><button className="button button-primary" disabled={!config || busy} onClick={() => { if (config) void execute(() => assignmentImportService.saveRouting(config.assignment_provider_id, config.material_provider_id), '模型分配已保存') }}>保存模型分配</button></div>
    <div className="module-settings-section"><h3>提示词文件</h3><p className="helper-text">每次识别读取本地文件，修改后无需重启。用户提示词须保留 {'{content}'} 占位符。</p><p className="module-settings-path" title={config?.prompt_directory}>{config?.prompt_directory || '加载中…'}</p><button className="button button-quiet" onClick={() => { void assignmentImportService.openPromptDirectory().catch(e => setMessage(errorText(e))) }}><FolderOpen size={16} />打开提示词文件夹</button></div>
    <p className="module-settings-security"><ShieldCheck size={17} />API Key 保存在 Windows 凭据管理器；数据库备份不包含密钥和提示词文件。</p>
    {message ? <p className="helper-text" role="status">{message}</p> : null}
    {editor ? <ProviderEditor initial={editor} onClose={() => setEditor(null)} onSave={async value => { const okay = await execute(() => assignmentImportService.saveProvider(value), '服务商已保存'); if (okay) setEditor(null) }} /> : null}
    </> : null}
  </section>
}
