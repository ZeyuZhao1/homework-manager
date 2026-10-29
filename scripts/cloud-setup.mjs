import { mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { outsideRepository } from './cloud-deploy.mjs'

/** Create an unfilled template only; never use the maintainer's account or credentials. */
export function setupCloudDirectory(directory, root) {
  // Resolve an existing ancestor before creating directories, including symlinks.
  let ancestor = resolve(directory)
  for (;;) {
    try { realpathSync(ancestor); break } catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      ancestor = dirname(ancestor)
    }
  }
  if (!outsideRepository(ancestor, root)) throw new Error('Choose a private directory outside the repository')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!outsideRepository(directory, root)) throw new Error('Private directory must not resolve into the repository')
  const template = readFileSync(resolve(root, 'deploy/cloudflare/config.example.json'), 'utf8')
  // Exclusive creation also rejects preexisting symlinks and preserves existing deployments.
  writeFileSync(resolve(directory, 'cloud.json'), template, { flag: 'wx', mode: 0o600 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--dir') throw new Error('Usage: pnpm cloud:setup --dir /absolute/outside-checkout/private-directory')
    setupCloudDirectory(resolve(args[1]), resolve(dirname(fileURLToPath(import.meta.url)), '..'))
    console.log('Created cloud.json in your private directory. Fill in your own Cloudflare resources; see deploy/cloudflare/README.md.')
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'cloud.json already exists; existing configuration was preserved.' : error.message)
    process.exitCode = 1
  }
}
