import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../src/theme.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace('export function applyTheme', 'function applyTheme') + '\nglobalThis.applyTheme = applyTheme;'
function setup() {
  const root = { dataset: {}, style: {} }, body = { style: {} }, handlers = new Map(), saved = new Map()
  const media = { matches: false, addEventListener: (event, handler) => handlers.set('system', handler) }
  let meta, cookie = '', replaced = 0
  const attach = value => { meta = value; meta.setAttribute = (key, value) => { meta[key] = value }; meta.replaceWith = replacement => { replaced++; attach(replacement) } }
  const document = { documentElement: root, body, head: { append: attach }, createElement: () => ({}), hidden: false, querySelector: selector => selector.includes('theme-color') ? meta : { setAttribute() {} }, addEventListener: (event, handler) => handlers.set(event, handler), get cookie() { return cookie }, set cookie(value) { cookie = value } }
  attach({})
  const context = vm.createContext({ document, window: { addEventListener: (event, handler) => handlers.set(event, handler) }, matchMedia: () => media, localStorage: { setItem: (key, value) => saved.set(key, value) }, location: { protocol: 'https:' } })
  vm.runInContext(source, context)
  return { root, body, handlers, media, saved, apply: context.applyTheme, meta: () => meta, replaced: () => replaced }
}
test('system appearance changes the complete canvas live and keeps the system preference', () => {
  const f = setup(); f.apply('system')
  assert.equal(f.root.dataset.theme, 'light')
  f.media.matches = true; f.handlers.get('system')()
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.body.style.backgroundColor, '#1b1b1d')
  assert.equal(f.meta().content, '#1b1b1d'); assert.equal(f.saved.get('homeworkbook:theme'), 'system')
  assert.equal(f.root.dataset.themePreference, 'system')
})
test('explicit appearance refreshes canvas and chrome without system overrides or navigation', () => {
  const f = setup(); f.apply('dark'); f.apply('light')
  f.media.matches = true; f.handlers.get('system')()
  assert.equal(f.root.dataset.theme, 'light'); assert.equal(f.root.style.backgroundColor, f.body.style.backgroundColor)
  assert.equal(f.meta().content, '#f0f3f8'); assert.equal(f.replaced(), 0)
  f.body.style.backgroundColor = 'stale'; f.handlers.get('pageshow')()
  assert.equal(f.body.style.backgroundColor, '#f0f3f8')
  assert.equal(f.handlers.size, 3)
})
