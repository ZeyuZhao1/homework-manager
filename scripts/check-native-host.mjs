import { execFileSync } from 'node:child_process'
import { desktopTargets } from './desktop-targets.mjs'

const spec = desktopTargets.find(item => item.id === process.argv[2])
if (!spec || process.platform !== spec.platform || process.arch !== spec.arch) throw new Error('Runner/Node architecture does not match the native build target')
const rust = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
if (!rust.split(/\r?\n/).includes(`host: ${spec.target}`)) throw new Error('Rust toolchain must run natively on the requested target')
console.log(`Native runner and Rust toolchain verified: ${spec.id} (${spec.target})`)
