// These helpers only prepare picker paths; the Rust core still validates roots.
export function pathSeparator(root: string) { return root.startsWith('/') ? '/' : '\\' }

export function relativeCoursePath(root: string, absolute: string): string | null {
  const separator = pathSeparator(root)
  const normalize = (value: string) => separator === '\\' ? value.replaceAll('/', '\\') : value
  const base = normalize(root).replace(separator === '/' ? /\/+$/ : /\\+$/, '') + separator
  const path = normalize(absolute)
  const matches = separator === '/' ? path.startsWith(base) : path.toLowerCase().startsWith(base.toLowerCase())
  return matches ? path.slice(base.length) : null
}

export function parentCoursePath(root: string, relative: string): string {
  return relative.split(pathSeparator(root)).slice(0, -1).join(pathSeparator(root))
}

export function coursePickerPath(root: string, relative: string): string | undefined {
  if (!root) return undefined
  if (!relative) return root
  const separator = pathSeparator(root)
  return root.replace(separator === '/' ? /\/+$/ : /\\+$/, '') + separator + relative
}
