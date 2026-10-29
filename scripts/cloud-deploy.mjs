import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Derive code locations without copying private values into the checkout. */
export function productionConfiguration(template, privateConfig, root) {
  if (!privateConfig || typeof privateConfig !== 'object' || Array.isArray(privateConfig)) throw new Error('Private configuration must be a JSON object')
  if (typeof privateConfig.name !== 'string' || !privateConfig.name || privateConfig.name.startsWith('homework-local-example')) throw new Error('Private configuration must name your production Worker')
  if (!Array.isArray(privateConfig.r2_buckets) || !privateConfig.r2_buckets.some(value => value.binding === 'FILES' && typeof value.bucket_name === 'string')) throw new Error('Private configuration must bind your own R2 bucket as FILES')
  if (Object.keys(privateConfig.vars || {}).some(key => /SECRET|TOKEN|KEY|PASSWORD/i.test(key))) throw new Error('Credentials must use Worker secrets, not configuration vars')
  return {
    ...template, ...privateConfig,
    main: resolve(root, 'cloud/src/index.ts'),
    assets: { ...template.assets, ...privateConfig.assets, directory: resolve(root, 'dist') },
    durable_objects: template.durable_objects,
    migrations: template.migrations,
    observability: { enabled: false },
  }
}

export function outsideRepository(path, root) {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm cloud:deploy --config /absolute/private/cloud.json [--dry-run]')
    process.exit(0)
  }
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const configIndex = process.argv.indexOf('--config')
    if (configIndex < 0 || !process.argv[configIndex + 1]) throw new Error('Usage: pnpm cloud:deploy --config /absolute/private/cloud.json [--dry-run]')
    const privatePath = resolve(process.argv[configIndex + 1])
    if (!outsideRepository(privatePath, root)) throw new Error('The private deployment configuration must be outside the repository, including through symlinks')
    const parsed = ts.parseConfigFileTextToJson('local-template', readFileSync(resolve(root, 'cloud/wrangler.jsonc'), 'utf8'))
    if (parsed.error) throw new Error('Invalid public local configuration')
    const config = productionConfiguration(parsed.config, JSON.parse(readFileSync(privatePath, 'utf8')), root)
    const generatedDir = resolve(dirname(privatePath), '.generated-homework-cloud')
    mkdirSync(generatedDir, { recursive: true, mode: 0o700 })
    if (!outsideRepository(generatedDir, root)) throw new Error('Generated private configuration directory must not resolve into the repository')
    const generatedPath = resolve(generatedDir, 'wrangler.private.json')
    writeFileSync(generatedPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    const args = ['exec', 'wrangler', 'deploy', '--config', generatedPath]
    if (process.argv.includes('--dry-run')) args.push('--dry-run', '--outdir', resolve(generatedDir, 'dry-run'))
    const result = spawnSync('pnpm', args, { cwd: resolve(root, 'cloud'), stdio: 'inherit', shell: process.platform === 'win32' })
    process.exitCode = result.status ?? 1
  } catch (error) { console.error(error instanceof Error ? error.message : 'Private deployment configuration failed'); process.exitCode = 1 }
}
