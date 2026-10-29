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
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (value[i] && typeof value[i] === 'object') errors.push(...inspectCloudConfig(value[i], `${path}[${i}]`))
      } else errors.push(...inspectCloudConfig(value, path))
    }
  }
  return errors
}

export function checkCloudPrivacy(root = process.cwd()) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
  const errors = []
  for (const name of files) {
    const path = resolve(root, name)
    if (!existsSync(path) || !statSync(path).isFile()) continue
    if (/(?:^|\/)(?:\.dev\.vars(?:\.|$)|\.wrangler\/|private\/|\.private\/)|(?:wrangler|cloudflare)\.(?:private|production)\.|\.secrets\.json$/.test(name)) errors.push(`${name}: private runtime/deployment file is a public candidate`)
    if (/(?:^|\/)wrangler[^/]*\.jsonc?$/.test(name)) {
      const { config, error } = ts.parseConfigFileTextToJson(name, readFileSync(path, 'utf8'))
      if (error) errors.push(`${name}: invalid configuration JSON`)
      else errors.push(...inspectCloudConfig(config).map(item => `${name}: ${item}`))
    }
    if (/^\.github\/workflows\//.test(name) && /cloud:deploy|wrangler\s+(?:deploy|secret)|CLOUDFLARE_API_TOKEN/.test(readFileSync(path, 'utf8'))) errors.push(`${name}: personal cloud deployment must use a private workflow or local command`)
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkCloudPrivacy()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Cloud privacy check passed: public candidates contain only local infrastructure examples.')
}
