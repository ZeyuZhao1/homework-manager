import { createRequire } from 'node:module'
import { readdir, readFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// API-only deployment alternative: no deployment identifiers or credentials enter
// the compiled module. Normal Wrangler deployments continue using Static Assets.
export async function buildEmbeddedWorker(root, output) {
  const require = createRequire(realpathSync(resolve(root, 'cloud/node_modules/wrangler/package.json')))
  const { build } = require('esbuild')
  const assets = {}
  const types = { '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.html':'text/html; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes:true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (!entry.name.startsWith('_') && !entry.name.startsWith('.')) {
        const bytes = await readFile(path)
        assets[`/${path.slice(resolve(root,'dist').length+1).replaceAll('\\','/')}`] = { body:gzipSync(bytes).toString('base64'), type:types[extname(path)] || 'application/octet-stream', etag:createHash('sha256').update(bytes).digest('hex') }
      }
    }
  }
  await walk(resolve(root,'dist'))
  if (!assets['/index.html']) throw new Error('Build the frontend before preparing the Worker')
  await mkdir(dirname(output), { recursive:true, mode:0o700 })
  const entry = `import app, {PersonalSpace} from ${JSON.stringify(resolve(root,'cloud/src/index.ts'))};
export {PersonalSpace};
const assets=${JSON.stringify(assets)};
async function serve(request){
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const path=new URL(request.url).pathname,asset=assets[path]||assets['/index.html'];
  const headers=new Headers({'Content-Type':asset.type,'ETag':'"'+asset.etag+'"','Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});
  if(request.headers.get('If-None-Match')===headers.get('ETag'))return new Response(null,{status:304,headers});
  const bytes=Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0));
  // Return decoded bytes: Workers applies HTTP compression itself. Setting gzip
  // on an already compressed body would cause the runtime to encode it twice.
  const body=request.method==='HEAD'?null:new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(body,{headers});
}
export default {fetch(request,env,ctx){return app.fetch(request,{...env,ASSETS:{fetch:serve}},ctx)},scheduled:app.scheduled};`
  await build({ stdin:{ contents:entry, resolveDir:root, loader:'js' }, outfile:output, bundle:true, format:'esm', platform:'browser', target:'es2022', external:['cloudflare:workers'], minify:true, logLevel:'silent' })
  return Object.keys(assets).length
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
  const index=process.argv.indexOf('--out')
  if(index<0||!process.argv[index+1])throw new Error('Provide --out /absolute/private/worker.js')
  console.log(`Prepared embedded Worker with ${await buildEmbeddedWorker(root,resolve(process.argv[index+1]))} public assets.`)
}
