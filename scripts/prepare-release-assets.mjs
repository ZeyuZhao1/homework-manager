import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { desktopTargets, assetName } from './desktop-targets.mjs'

export function binaryArchitecture(bytes) {
  if (bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18)
    return bytes[4] === 2 ? ({ 62: 'x64', 183: 'arm64' }[machine]) : undefined
  }
  if (bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0') {
      return { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(offset + 4)]
    }
  }
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { 0x01000007: 'x64', 0x0100000c: 'arm64' }[bytes.readUInt32LE(4)]
  }
  return undefined
}

function onlyFile(directory, extension) {
  const files = readdirSync(directory).filter(name => name.endsWith(extension) && statSync(join(directory, name)).isFile())
  if (files.length !== 1) throw new Error(`Expected one ${extension} in ${directory}; found ${files.length}`)
  return join(directory, files[0])
}

export function prepareAssets(id, version, targetRoot = 'src-tauri/target', output = 'release-assets') {
  const spec = desktopTargets.find(item => item.id === id)
  if (!spec) throw new Error(`Unknown desktop target: ${id}`)
  const release = join(targetRoot, spec.target, 'release')
  const binary = join(release, spec.platform === 'win32' ? 'homework-manager.exe' : 'homework-manager')
  if (binaryArchitecture(readFileSync(binary)) !== spec.arch) throw new Error(`Wrong executable architecture for ${id}`)
  mkdirSync(output, { recursive: true })
  for (const format of spec.formats) {
    const source = format === 'portable.exe' ? binary : format === 'installer.exe' ? onlyFile(join(release, 'bundle/nsis'), '.exe')
      : onlyFile(join(release, 'bundle', format === 'AppImage' ? 'appimage' : format), `.${format}`)
    if (statSync(source).size === 0) throw new Error(`Empty artifact: ${source}`)
    copyFileSync(source, join(output, assetName(version, id, format)))
  }
}

export function writeChecksums(version, directory = 'release-assets') {
  const expected = desktopTargets.flatMap(spec => spec.formats.map(format => assetName(version, spec.id, format))).sort()
  const actual = readdirSync(directory).filter(name => name !== 'SHA256SUMS.txt').sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release artifacts are missing, unexpected, or from another version')
  const lines = expected.map(name => {
    const bytes = readFileSync(join(directory, name))
    if (!bytes.length) throw new Error(`Empty artifact: ${name}`)
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`
  })
  writeFileSync(join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  if (process.argv[2] === '--checksums') writeChecksums(version)
  else prepareAssets(process.argv[2], version)
}
