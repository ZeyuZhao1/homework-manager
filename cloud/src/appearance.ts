// This cookie is only an appearance preference, never an authentication token.
export function requestAppearance(request: Request): 'light' | 'dark' {
  const match = request.headers.get('cookie')?.match(/(?:^|;\s*)homeworkbook_theme=(light|dark)(?:;|$)/)
  return match?.[1] === 'dark' ? 'dark' : 'light'
}
export async function appearanceAsset(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url)
  const manifest = url.pathname === '/manifest.webmanifest'
  const documentRequest = url.pathname === '/' || url.pathname.endsWith('.html') || request.headers.get('accept')?.includes('text/html')
  const assetRequest = new Request(request, request.method === 'HEAD' && (manifest || documentRequest) ? { method: 'GET' } : undefined)
  // An older cached HTML/manifest must not return 304 before it can be themed.
  if (manifest || documentRequest) {
    assetRequest.headers.delete('if-none-match')
    assetRequest.headers.delete('if-modified-since')
  }
  const asset = await assets.fetch(assetRequest)
  if (asset.status !== 200) return asset
  const html = asset.headers.get('content-type')?.includes('text/html')
  if (!html && !manifest) return asset
  const queryTheme = url.searchParams.get('theme')
  const theme = manifest && (queryTheme === 'light' || queryTheme === 'dark') ? queryTheme : requestAppearance(request)
  const color = theme === 'dark' ? '#1b1b1d' : '#f0f3f8'
  // Both appearances draw the application behind the system status area.
  const statusBar = 'black-translucent'
  const response = new Response(asset.body, asset)
  response.headers.delete('etag')
  response.headers.delete('last-modified')
  response.headers.delete('content-length')
  response.headers.set('cache-control', 'private, no-store')
  if (manifest) {
    const data = await response.json<Record<string, unknown>>()
    response.headers.delete('content-encoding')
    return request.method === 'HEAD' ? new Response(null, response) : Response.json({ ...data, background_color: color, theme_color: color }, { headers: response.headers })
  }
  const rewritten = new HTMLRewriter()
    .on('html', { element(element) { element.setAttribute('data-theme', theme); element.setAttribute('data-appearance-rendered', 'true') } })
    .on('meta[name="color-scheme"]', { element(element) { element.setAttribute('content', theme) } })
    .on('meta[name="theme-color"]', { element(element) { element.setAttribute('content', color) } })
    .on('meta[name="apple-mobile-web-app-status-bar-style"]', { element(element) { element.setAttribute('content', statusBar) } })
    .on('link[rel="manifest"]', { element(element) { element.setAttribute('href', `/manifest.webmanifest?theme=${theme}&v=4`) } })
    .transform(response)
  return request.method === 'HEAD' ? new Response(null, rewritten) : rewritten
}
