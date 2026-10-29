import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))]
const allowedModules = new Set(['assignment-import', 'recurring-assignments'])
const errors = []
for (const file of files.filter(file => file.startsWith('modules/'))) {
  const parts = file.split('/')
  if (file !== 'modules/registry.rs' && !allowedModules.has(parts[1])) errors.push(`Unexpected tracked module: ${file}`)
}
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const version = json('package.json').version
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').split(/\[package\]/)[1]?.split(/\n\[/)[0]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const lock = readFileSync('src-tauri/Cargo.lock', 'utf8').split('[[package]]').find(block => /^name = "homework-manager"$/m.test(block))?.match(/^version = "([^"]+)"/m)?.[1]
const versions = [['Tauri', json('src-tauri/tauri.conf.json').version], ['Cargo', cargo], ['Cargo.lock', lock]]
for (const name of allowedModules) {
  const path = `modules/${name}/module.json`
  if (!files.includes(path)) errors.push(`Missing maintained module: ${name}`)
  const manifest = json(path)
  versions.push([name, manifest.version])
  if (manifest.builtin !== true) errors.push(`Expected a built-in module: ${name}`)
}
for (const [name, actual] of versions) if (actual !== version) errors.push(`${name}: version ${actual} differs from ${version}`)

// Check local file destinations, including image links; heading anchors are out of scope.
const root = resolve('.')
for (const file of files.filter(file => file.endsWith('.md'))) {
  const content = readFileSync(file, 'utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '')
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1].replace(/^<|>$/g, '')
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) continue
    let destination
    try { destination = decodeURIComponent(href.split(/[?#]/)[0]) }
    catch { errors.push(`${file}: invalid URL ${href}`); continue }
    const path = resolve(dirname(file), destination)
    if (!path.startsWith(root + sep) || !existsSync(path)) errors.push(`${file}: missing local link ${href}`)
  }
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Repository check passed: two maintained modules, version ${version}, local Markdown file links.`)
}
