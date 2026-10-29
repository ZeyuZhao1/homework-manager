import type { EntityStore } from './store'
import { CredentialError, readAiCredential } from './ai-credentials'
import { systemPrompt, userPrompt } from './ai-prompts'

class AiError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
type Row = Record<string, unknown>
type Provider = { kind: string; base_url: string; model: string }
const MAX_BODY = 2 * 1024 * 1024
const MAX_FILE = 20 * 1024 * 1024
// Base64 plus JSON is bounded below the Workers isolate memory budget. Sequential uploads
// also keep subrequests bounded (at most 4 uploads + generation + 4 cleanup requests).
const MAX_TOTAL = 20 * 1024 * 1024
const MAX_FILES = 4
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
function fail(message: string): never { throw new AiError(message) }
async function boundedJson(input: Request | Response, limit = MAX_BODY): Promise<unknown> {
  if (Number(input.headers.get('content-length')) > limit) fail('请求或响应超过大小限制')
  const reader = input.body?.getReader()
  if (!reader) fail('请求或响应为空')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > limit) { await reader.cancel(); fail('请求或响应超过大小限制') }; chunks.push(value) }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return fail('请求或响应 JSON 无效') }
}
function classify(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return { type: 'pdf', mime: 'application/pdf' }
  if (ext === 'docx') return { type: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
  if (ext && mime[ext]) return { type: 'image', mime: mime[ext] }
  return fail('仅支持 PDF、DOCX、PNG、JPEG、GIF 或 WebP 文件')
}
function capability(p: Provider, names: string[]) {
  const model = p.model.toLowerCase()
  const fileModel = p.kind === 'bailian' && (model.startsWith('qwen-long') || model === 'qwen-doc-turbo')
  if (model === 'qwen-doc-turbo' && names.length > 1) fail('qwen-doc-turbo 一次只支持一个文件')
  for (const name of names) {
    const { type } = classify(name)
    if (type === 'pdf' && !(p.kind === 'gemini' || (p.kind === 'bailian' && (model.startsWith('qwen3.8-') || fileModel)))) fail('所选模型不支持直接传入 PDF')
    if (type === 'docx' && !fileModel) fail('DOCX 需要百炼 qwen-long 或 qwen-doc-turbo')
    if (type === 'image' && !(fileModel || p.kind === 'gemini' || (p.kind === 'deepseek' && model === 'deepseek-flash') || (p.kind === 'bailian' && (model.startsWith('qwen3.8-') || model.includes('vl'))))) fail('所选模型不支持图片')
  }
  return fileModel
}
function base64(bytes: Uint8Array) {
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += 0x6000) parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 0x6000))))
  return parts.join('')
}
export function extractAssignments(content: string, courses: { id: string; name: string; code: string }[]) {
  let text = content.trim().replace(/^\uFEFF/, '').trimStart()
  while (text.startsWith('<think>')) { const end = text.indexOf('</think>'); if (end < 0) fail('模型只返回了思考内容'); text = text.slice(end + 8).trimStart() }
  const start = text.search(/[{[]/)
  if (start < 0) fail('模型未返回可解析的作业 JSON')
  // Scan one complete outer JSON value; never rescue inner objects from truncation.
  let quoted = false; let escaped = false; const stack: string[] = []; let end = -1
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') { quoted = true; continue }
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') { if (stack.pop() !== (c === '}' ? '{' : '[')) fail('模型返回的 JSON 语法无效'); if (!stack.length) { end = i + 1; break } }
  }
  if (end < 0) fail('模型返回的作业 JSON 不完整，请减少本次内容或分批识别')
  let value: unknown
  try { value = JSON.parse(text.slice(start, end)) } catch { return fail('模型返回的 JSON 语法无效') }
  if (/^[{[]/.test(text.slice(end).trimStart())) fail('模型返回了多个 JSON 结果')
  const row = object(value)
  const items = Array.isArray(value) ? value : 'assignments' in row ? row.assignments : 'title' in row ? [row] : null
  if (!Array.isArray(items)) fail('模型返回的 assignments 必须是作业数组')
  if (items.length > 500) fail('单次识别作业过多，请分批识别')
  const assignments = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`第 ${index + 1} 项作业必须是对象`)
    const input = object(item); const draft: Record<string, string | null> = {}
    for (const field of ['course_name', 'course_id', 'title', 'description', 'submission_label', 'submission_url', 'submission_notes', 'evidence']) {
      const v = input[field]
      if (v != null && typeof v !== 'string') fail(`第 ${index + 1} 项作业字段 ${field} 必须是字符串`)
      draft[field] = typeof v === 'string' ? v : ''
    }
    const due = input.due_at
    if (due != null && typeof due !== 'string') fail(`第 ${index + 1} 项作业字段 due_at 必须是时间字符串或 null`)
    const date = typeof due === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(due) ? new Date(`${due}Z`) : null
    draft.due_at = date && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 19) === due ? due as string : null
    const name = (draft.course_name || '').toLowerCase()
    const matches = courses.filter(course => course.name.toLowerCase() === name || (!!course.code && course.code.toLowerCase() === name))
    draft.course_id = name && matches.length === 1 ? matches[0].id : ''
    return draft
  }).filter(draft => draft.title?.trim())
  if (!assignments.length) fail('未识别出独立作业，请检查输入内容')
  return { assignments }
}
function responseText(value: unknown, gemini: boolean) {
  const root = object(value)
  if (gemini) {
    const candidate = object(Array.isArray(root.candidates) ? root.candidates[0] : null)
    if (candidate.finishReason === 'MAX_TOKENS') fail('模型输出达到长度上限，请分批识别')
    if (candidate.finishReason && candidate.finishReason !== 'STOP') fail('服务商未完成本次识别，请检查输入或切换模型')
    const parts = object(candidate.content).parts
    if (!Array.isArray(parts)) fail('Gemini 未返回识别结果，内容可能被拦截')
    const text = parts.filter(p => object(p).thought !== true).map(p => typeof object(p).text === 'string' ? object(p).text : '').join('')
    if (!text.trim()) fail('服务商没有返回文字内容')
    return text
  }
  const choice = object(Array.isArray(root.choices) ? root.choices[0] : null)
  if (choice.finish_reason === 'length') fail('模型输出达到长度上限，请分批识别')
  if (choice.finish_reason === 'content_filter') fail('服务商拦截了本次识别内容')
  const message = object(choice.message)
  if (typeof message.refusal === 'string' && message.refusal.trim()) fail('模型拒绝了本次识别')
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(p => object(p).type === 'text').map(p => typeof object(p).text === 'string' ? object(p).text : '').join('') : ''
  if (!text.trim()) fail('服务商没有返回文字内容')
  return text
}

export async function handleAi(request: Request, env: Env, store: EntityStore): Promise<Response> {
  const uploaded: string[] = []
  let cleanup: ((id: string) => Promise<void>) | undefined
  try {
    const input = object(await boundedJson(request))
    if (typeof input.text !== 'string' || (input.file_ids !== undefined && (!Array.isArray(input.file_ids) || !input.file_ids.every(id => typeof id === 'string')))) fail('识别输入格式无效')
    const text = input.text as string; const ids = [...new Set((input.file_ids || []) as string[])]
    if (input.timezone !== undefined && (typeof input.timezone !== 'string' || input.timezone.length > 100 || !input.timezone)) fail('识别时区无效')
    const timezone = typeof input.timezone === 'string' ? input.timezone : 'Asia/Shanghai'
    let today: string
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
      const part = (type: string) => parts.find(item => item.type === type)?.value || ''
      today = `${part('year')}-${part('month')}-${part('day')}`
    } catch { return fail('识别时区无效，请使用 IANA 时区名称') }
    if (!text.trim() && !ids.length) fail('请粘贴内容或选择文件')
    if (ids.length > MAX_FILES) fail('网页识别每次最多 4 个附件，请分批识别')
    if (store.read('module_state', 'builtin.ai.assignment-import')?.data?.enabled === false) fail('AI 作业导入模块已关闭')
    const selected = store.read('ai_setting', 'assignment_provider_id')?.data?.value
    if (typeof selected !== 'string' || !selected) fail('请先为作业识别指定 AI 服务商')
    const metadata = store.read('provider', selected)?.data
    if (!metadata || !['bailian', 'deepseek', 'gemini', 'custom'].includes(String(metadata.kind)) || typeof metadata.model !== 'string' || !metadata.model || typeof metadata.base_url !== 'string') fail('服务商配置无效')
    const provider: Provider = { kind: String(metadata.kind), model: String(metadata.model), base_url: String(metadata.base_url).replace(/\/+$/, '') }
    const url = new URL(provider.base_url)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) fail('服务地址必须使用 HTTPS，且不能包含凭据、查询参数或片段')
    if (provider.kind === 'gemini' && !/^[A-Za-z0-9_.-]+$/.test(provider.model)) fail('Gemini 模型名称无效')
    const key = await readAiCredential(env, selected)
    if (!key) throw new AiError('请在 AI 服务商设置中填写网页 API Key；桌面密钥不会上传', 503)
    const files = ids.map(id => { const data = store.read('file', id)?.data; if (!data || typeof data.cloud_version !== 'string' || !data.cloud_version.startsWith(`content/${id}/`) || typeof data.name !== 'string') return fail('附件内容尚未确认上传，请先上传后识别'); return { id, name: data.name, version: data.cloud_version, size: Number(data.size) } })
    let total = 0
    for (const file of files) { if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_FILE) fail('单个附件不能超过 20 MB'); total += file.size }
    if (total > MAX_TOTAL) fail('网页识别附件合计不能超过 20 MB，请分批识别')
    const fileModel = capability(provider, files.map(f => f.name))
    const courses = store.snapshot().entities.filter(row => row.entity_type === 'course' && row.data).map(row => ({ id: row.entity_id, name: String(row.data?.name || ''), code: String(row.data?.code || '') }))
    const prompt = userPrompt.replaceAll('{date}', today).replaceAll('{courses}', JSON.stringify(courses.map(({ name, code }) => ({ name, code })))).replaceAll('{content}', text)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), files.some(file => classify(file.name).type === 'pdf') ? 360000 : 120000)
    const headers: Record<string, string> = provider.kind === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }
    const send = async (path: string, body: BodyInit, json: boolean) => {
      const response = await fetch(`${provider.base_url}${path}`, { method: 'POST', headers: { ...headers, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body, signal: controller.signal, redirect: 'manual' })
      if (!response.ok) { await response.body?.cancel(); throw new AiError(`服务商请求失败 (${response.status})，请检查私密配置、模型和配额`, 502) }
      return boundedJson(response)
    }
    cleanup = async id => { const response = await fetch(`${provider.base_url}/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000), redirect: 'manual' }); await response.body?.cancel() }
    try {
      const content: unknown[] = [{ type: 'text', text: prompt }]; const parts: unknown[] = [{ text: prompt }]
      for (const file of files) {
        const blob = await env.FILES.get(file.version)
        if (!blob || blob.size !== file.size || blob.size > MAX_FILE) fail('附件内容不可用或大小已变更，请重新上传')
        const { type, mime } = classify(file.name)
        if (fileModel) {
          const form = new FormData(); form.append('purpose', 'file-extract'); form.append('file', new Blob([await blob.arrayBuffer()], { type: mime }), file.name)
          const result = object(await send('/files', form, false))
          if (typeof result.id !== 'string' || !result.id || result.id.length > 512) fail('服务商文件上传未返回有效 ID')
          uploaded.push(result.id)
        } else {
          const encoded = base64(new Uint8Array(await blob.arrayBuffer()))
          if (provider.kind === 'gemini') parts.push({ inline_data: { mime_type: mime, data: encoded } })
          else if (type === 'pdf') content.push({ type: 'file', file: { file_data: `data:${mime};base64,${encoded}`, filename: file.name } })
          else content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${encoded}` } })
        }
      }
      const gemini = provider.kind === 'gemini'
      const body: Row = gemini ? { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } } : { model: provider.model, messages: [{ role: 'system', content: systemPrompt }, ...uploaded.map(id => ({ role: 'system', content: `fileid://${id}` })), { role: 'user', content: fileModel ? prompt : content }], temperature: 0.1 }
      if (!gemini && (provider.kind === 'deepseek' || (provider.kind === 'bailian' && ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen-long'].some(prefix => provider.model.toLowerCase().startsWith(prefix))))) body.response_format = { type: 'json_object' }
      const result = await send(gemini ? `/models/${provider.model}:generateContent` : '/chat/completions', JSON.stringify(body), true)
      return Response.json(extractAssignments(responseText(result, gemini), courses), { headers: { 'Cache-Control': 'no-store' } })
    } finally { clearTimeout(timeout) }
  } catch (error) {
    // Do not expose provider body, URL, user content, request headers, or infrastructure errors.
    return Response.json({ error: (error instanceof AiError || error instanceof CredentialError) ? error.message : '云端识别请求失败或超时，请稍后重试' }, { status: (error instanceof AiError || error instanceof CredentialError) ? error.status : 502, headers: { 'Cache-Control': 'no-store' } })
  } finally {
    for (const id of uploaded) { try { await cleanup?.(id) } catch { /* Best effort, never expose remote errors. */ } }
  }
}
