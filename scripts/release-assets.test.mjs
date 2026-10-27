import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { binaryArchitecture, prepareAssets, writeChecksums } from './prepare-release-assets.mjs'
import { desktopTargets, assetName } from './desktop-targets.mjs'

function header(platform, arch) {
  const bytes = Buffer.alloc(128)
  if (platform === 'win32') {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64)
    bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
  } else if (platform === 'linux') {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  } else {
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  }
  return bytes
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'homework-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, targetRoot: join(root, 'target'), output: join(root, 'assets') }
}

function bundle(spec, targetRoot, arch = spec.arch) {
  const release = join(targetRoot, spec.target, 'release')
  mkdirSync(release, { recursive: true })
  writeFileSync(join(release, spec.platform === 'win32' ? 'homework-manager.exe' : 'homework-manager'), header(spec.platform, arch))
  for (const format of spec.formats.filter(format => format !== 'portable.exe')) {
    const directory = join(release, 'bundle', format === 'installer.exe' ? 'nsis' : format === 'AppImage' ? 'appimage' : format)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `installer.${format === 'installer.exe' ? 'exe' : format}`), `synthetic ${spec.id} bundle`)
  }
}

test('matrix covers four requested native targets and existing Windows x64', () => {
  assert.equal(new Set(desktopTargets.map(item => item.target)).size, 5)
  assert.deepEqual(desktopTargets.map(item => item.id).sort(), ['linux-arm64', 'linux-x64', 'macos-arm64', 'windows-arm64', 'windows-x64'])
})

test('ELF, PE and Mach-O distinguish ARM64 from x64 and reject unknown/truncated binaries', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const arch of ['x64', 'arm64']) assert.equal(binaryArchitecture(header(platform, arch)), arch)
  }
  assert.equal(binaryArchitecture(Buffer.from('not executable')), undefined)
  const malformed = header('win32', 'arm64'); malformed.writeUInt32LE(0xffffffff, 0x3c)
  assert.equal(binaryArchitecture(malformed), undefined)
})

test('collects every native bundle and hashes all nine assets with stable filenames', t => {
  const { targetRoot, output } = fixture(t)
  for (const spec of desktopTargets) {
    bundle(spec, targetRoot)
    prepareAssets(spec.id, '1.2.3', targetRoot, output)
  }
  writeChecksums('1.2.3', output)
  assert.equal(readdirSync(output).length, 10)
  assert.ok(readdirSync(output).includes('homework-manager-v1.2.3-windows-x64-portable.exe'))
  const sums = readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')
  assert.equal(sums.length, 9)
  for (const line of sums) {
    const [hash, name] = line.split('  ')
    assert.equal(hash, createHash('sha256').update(readFileSync(join(output, name))).digest('hex'))
  }
})

test('an x64 executable cannot be published as ARM64', t => {
  const { targetRoot, output } = fixture(t)
  const spec = desktopTargets.find(item => item.id === 'windows-arm64')
  bundle(spec, targetRoot, 'x64')
  assert.throws(() => prepareAssets(spec.id, '1.2.3', targetRoot, output), /Wrong executable architecture/)
})

test('partial, stale and empty assets prevent publishing the shared manifest', t => {
  const { output } = fixture(t)
  mkdirSync(output)
  assert.throws(() => writeChecksums('1.2.3', output), /missing/)
  for (const spec of desktopTargets) for (const format of spec.formats) writeFileSync(join(output, assetName('1.2.3', spec.id, format)), 'bundle')
  writeFileSync(join(output, 'unexpected.exe'), 'stale')
  assert.throws(() => writeChecksums('1.2.3', output), /unexpected/)
  rmSync(join(output, 'unexpected.exe'))
  writeFileSync(join(output, assetName('1.2.3', desktopTargets[0].id, desktopTargets[0].formats[0])), '')
  assert.throws(() => writeChecksums('1.2.3', output), /Empty artifact/)
})
