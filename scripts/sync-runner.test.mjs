import test from 'node:test'
import assert from 'node:assert/strict'
import { createSyncRunner } from '../src/sync/runner.ts'

test('disabled and disconnected desktops never make synchronization requests', async () => {
  let requests = 0
  for (const status of [{ enabled:false, connected:true }, { enabled:true, connected:false }]) {
    const runner = createSyncRunner({ status:async()=>status, now:async()=>{ requests++ } }, ()=>{})
    await runner.tick()
  }
  assert.equal(requests, 0)
})
test('automatic rounds do not overlap and stopping suppresses late UI updates', async () => {
  let release
  let requests = 0, refreshes = 0
  const delayed = new Promise(resolve=>{release=resolve})
  const runner = createSyncRunner({ status:async()=>({enabled:true,connected:true}), now:async()=>{requests++; await delayed} }, ()=>{refreshes++})
  const first = runner.tick()
  await new Promise(resolve=>setImmediate(resolve))
  await runner.tick()
  assert.equal(requests,1)
  runner.stop(); release(); await first
  assert.equal(refreshes,0)
  await runner.tick(); assert.equal(requests,1)
})
test('successful synchronization announces refreshed state and retries after a network failure', async () => {
  let requests=0,refreshes=0
  const runner=createSyncRunner({status:async()=>({enabled:true,connected:true}),now:async()=>{if(++requests===1)throw new Error('temporary')}},()=>{refreshes++})
  await runner.tick(); await runner.tick()
  assert.equal(requests,2);assert.equal(refreshes,1)
})
