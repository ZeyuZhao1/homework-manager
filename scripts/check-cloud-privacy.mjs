import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const localNames = /^homework-local-example(?:-files)?$/
const placeholder = value => typeof value === 'string' && (/^<[^>]+>$/.test(value) || /^YOUR_[A-Z_]+$/.test(value))
const privateIdentifiers = new Set(['account_id', 'zone_id', 'database_id', 'namespace_id', 'script_id', 'client_secret', 'api_token', 'api_key'])

export function inspectCloudConfig(config, prefix = '') {
  const errors = []
  for (const [key, value] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (privateIdentifiers.has(key) && value !== '' && !placeholder(value)) errors.push(`${path}: private identifiers or credentials are not public configuration`)
    if (['bucket_name', 'database_name', 'name'].includes(key) && typeof value === 'string' && !localNames.test(value) && !placeholder(value) && !['SPACE', 'FILES', 'ASSETS'].includes(value)) errors.push(`${path}: use a synthetic local resource name or placeholder`)
    if (['routes', 'route', 'account_id'].includes(key) && value && !placeholder(value)) errors.push(`${path}: production routing belongs outside the repository`)
    if (key === 'vars' && value && Object.keys(value).length) errors.push(`${path}: private deployment variables belong outside the repository`)
    if (key === 'remote' && value === true) errors.push(`${path}: public local configuration must not connect to remote resources`)
    if (['workers_dev', 'preview_urls'].includes(key) && value === true) errors.push(`${path}: public local configuration must not publish an address`)
    if (key === 'script_name' && value && !placeholder(value)) errors.push(`${path}: cross-Worker bindings belong outside the repository`)
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (value[i] && typeof value[i] === 'object') errors.push(...inspectCloudConfig(value[i], `${path}[${i}]`))
      } else errors.push(...inspectCloudConfig(value, path))
    }
  }
  return errors
}

export function inspectDeploymentExample(config) {
  // A deployable shape may enable workers.dev, but every deployment identity remains a placeholder.
  const errors = inspectCloudConfig({ ...config, workers_dev: false, vars: {} })
  const vars = config.vars || {}
  if (Object.keys(vars).some(key => key !== 'PUBLIC_ORIGIN') || !/^https:\/\/<YOUR_[A-Z_]+>(?:\.<YOUR_[A-Z_]+>)*(?:\.workers\.dev)?$/.test(vars.PUBLIC_ORIGIN || '')) errors.push('vars: deployment examples must contain only a placeholder PUBLIC_ORIGIN')
  return errors
}

/** Indicators only; report locations and reasons, never matched credentials or URLs. */
export function inspectPublicText(content) {
  const text = content
  const errors = []
  if (/\b[a-z\d][a-z\d.-]*\.(?:workers\.dev|r2\.dev|r2\.cloudflarestorage\.com)\b/i.test(text)) errors.push('live Cloudflare service address; use placeholders and configure at runtime')
  if (/\b\d{8,}-[a-z\d_-]+\.apps\.googleusercontent\.com\b/i.test(text) || /\b(?:Ov23|Iv1\.)[a-z\d]{12,}\b/i.test(text)) errors.push('OAuth client identity; keep provider configuration outside the repository')
  if (/\b(?:gh[pousr]_[a-z\d]{30,}|github_pat_[a-z\d_]{40,}|AIza[a-z\d_-]{30,})\b/i.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) errors.push('credential indicator; review privately before publishing')
  return errors
}

export function checkCloudPrivacy(root = process.cwd()) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
  const errors = []
  for (const name of files) {
    const path = resolve(root, name)
    if (!existsSync(path) || !statSync(path).isFile()) continue
    if (/(?:^|\/)(?:\.env(?:\.|$)|\.dev\.vars(?:\.|$)|\.wrangler\/|private\/|\.private\/)|(?:wrangler|cloudflare)\.(?:private|production)\.|\.secrets\.json$|(?:^|\/)client_secret_[^/]*\.json$/.test(name)) errors.push(`${name}: private runtime/deployment file is a public candidate`)
    if (/(?:^|\/)(?:services|sync-device)\.json$/.test(name)) errors.push(`${name}: user runtime service selection and authorization state must not be published`)
    const content = readFileSync(path, 'utf8')
    errors.push(...inspectPublicText(content).map(item => `${name}: ${item}`))
    if (/(?:^|\/)wrangler[^/]*\.jsonc?$/.test(name)) {
      const { config, error } = ts.parseConfigFileTextToJson(name, content)
      if (error) errors.push(`${name}: invalid configuration JSON`)
      else errors.push(...inspectCloudConfig(config).map(item => `${name}: ${item}`))
    }
    if (/^deploy\/cloudflare\/.*\.example\.json$/.test(name)) {
      const { config, error } = ts.parseConfigFileTextToJson(name, content)
      if (error) errors.push(`${name}: invalid deployment example JSON`)
      else errors.push(...inspectDeploymentExample(config).map(item => `${name}: ${item}`))
    }
    if (/^\.github\/workflows\//.test(name) && /cloud:deploy|wrangler\s+(?:deploy|secret)|CLOUDFLARE_(?:API_TOKEN|API_KEY|ACCOUNT_ID)|secrets\s*:\s*inherit|--remote/.test(content)) errors.push(`${name}: personal cloud deployment must use a private workflow or local command`)
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkCloudPrivacy()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Cloud privacy checks passed: local configuration, deployment placeholders, public file indicators and CI rules.')
}
