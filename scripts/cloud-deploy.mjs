import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Derive code locations without copying private values into the checkout. */
export function productionConfiguration(template, privateConfig, root) {
  if (!privateConfig || typeof privateConfig !== 'object' || Array.isArray(privateConfig)) throw new Error('Private configuration must be a JSON object')
  if (/<[^>]+>|YOUR_[A-Z_]+/.test(JSON.stringify(privateConfig))) throw new Error('Replace all deployment placeholders with your own Cloudflare configuration')
  if (typeof privateConfig.name !== 'string' || !privateConfig.name || privateConfig.name.startsWith('homework-local-example')) throw new Error('Private configuration must name your production Worker')
  if (!/^[a-f\d]{32}$/i.test(privateConfig.account_id || '')) throw new Error('Private configuration must specify your own Cloudflare account_id')
  if (!Array.isArray(privateConfig.r2_buckets) || !privateConfig.r2_buckets.some(value => value.binding === 'FILES' && typeof value.bucket_name === 'string' && value.bucket_name && value.bucket_name !== 'homework-local-example-files')) throw new Error('Private configuration must bind your own R2 bucket as FILES')
  let origin
  try { origin = new URL(privateConfig.vars?.PUBLIC_ORIGIN) } catch { /* Fixed message avoids printing private input. */ }
  if (!origin || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_ORIGIN must be your own HTTPS origin without a path, credentials or query')
  if (privateConfig.workers_dev !== true && !privateConfig.routes?.length) throw new Error('Enable your workers.dev address or configure your own custom domain routes')
  if (Object.keys(privateConfig.vars || {}).some(key => /SECRET|TOKEN|KEY|PASSWORD/i.test(key))) throw new Error('Credentials must use Worker secrets, not configuration vars')
  return {
    ...template, ...privateConfig,
    main: resolve(root, 'cloud/src/index.ts'),
    assets: { ...template.assets, directory: resolve(root, 'dist') },
    durable_objects: template.durable_objects,
    migrations: template.migrations,
    observability: { enabled: false },
    logpush: false,
    preview_urls: false,
  }
}

export function deploymentArguments(args, generatedPath, generatedDir) {
  const configIndex = args.indexOf('--config')
  if (configIndex < 0 || !args[configIndex + 1]) throw new Error('Provide --config /absolute/outside-checkout/cloud.json')
  const rest = args.filter((_, index) => index !== configIndex && index !== configIndex + 1)
  if (rest.length === 0 || (rest.length === 1 && rest[0] === '--dry-run')) {
    return ['exec', 'wrangler', 'deploy', '--config', generatedPath, ...(rest.length ? ['--dry-run', '--outdir', resolve(generatedDir, 'dry-run')] : [])]
  }
  if (rest.length === 2 && rest[0] === '--secret' && /^[A-Z][A-Z0-9_]*$/.test(rest[1])) return ['exec', 'wrangler', 'secret', 'put', rest[1], '--config', generatedPath]
  throw new Error('Use --dry-run or --secret SECRET_NAME; secret values must be entered at the interactive prompt, never as arguments')
}

export function outsideRepository(path, root) {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm cloud:deploy --config /absolute/private/cloud.json [--dry-run | --secret SECRET_NAME]')
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
    const input = readFileSync(privatePath, 'utf8')
    let privateConfig
    try { privateConfig = JSON.parse(input) } catch { throw new Error('Invalid private configuration JSON; contents are not printed') }
    const config = productionConfiguration(parsed.config, privateConfig, root)
    const generatedDir = resolve(dirname(privatePath), '.generated-homework-cloud')
    mkdirSync(generatedDir, { recursive: true, mode: 0o700 })
    if (!outsideRepository(generatedDir, root)) throw new Error('Generated private configuration directory must not resolve into the repository')
    // A fresh restricted directory prevents overwriting existing files or symlink targets.
    const runDir = mkdtempSync(resolve(generatedDir, 'run-'))
    const generatedPath = resolve(runDir, 'wrangler.private.json')
    const args = deploymentArguments(process.argv.slice(2), generatedPath, runDir)
    writeFileSync(generatedPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
    const result = spawnSync('pnpm', args, { cwd: resolve(root, 'cloud'), stdio: 'inherit', shell: process.platform === 'win32' })
    process.exitCode = result.status ?? 1
  } catch (error) { console.error(error instanceof Error ? error.message : 'Private deployment configuration failed'); process.exitCode = 1 }
}
