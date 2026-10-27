import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Keep runners, native targets and distributed filenames in one place.
export const desktopTargets = [
  { id: 'windows-x64', runner: 'windows-2022', target: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64', formats: ['installer.exe', 'portable.exe'] },
  { id: 'windows-arm64', runner: 'windows-11-arm', target: 'aarch64-pc-windows-msvc', platform: 'win32', arch: 'arm64', formats: ['installer.exe', 'portable.exe'] },
  { id: 'macos-arm64', runner: 'macos-15', target: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64', formats: ['dmg'] },
  { id: 'linux-x64', runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu', platform: 'linux', arch: 'x64', formats: ['deb', 'AppImage'] },
  { id: 'linux-arm64', runner: 'ubuntu-24.04-arm', target: 'aarch64-unknown-linux-gnu', platform: 'linux', arch: 'arm64', formats: ['deb', 'AppImage'] },
]

export function assetName(version, id, format) {
  return `homework-manager-v${version}-${id}${format.endsWith('.exe') ? '-' : '.'}${format}`
}

if (process.argv.includes('--github-output')) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tag = process.env.RELEASE_TAG
  if (tag) {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${version}`) throw new Error('Release tag must match package.json version')
    const taggedSha = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim()
    if (sha !== taggedSha) throw new Error('Checkout must match the immutable release tag')
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: desktopTargets })}\ncommit=${sha}\n`)
}
