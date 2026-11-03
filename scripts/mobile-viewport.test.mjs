import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source = ts.transpileModule(readFileSync(new URL('../src/mobileViewport.ts', import.meta.url),'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('export function installMobileViewport','function installMobileViewport')+'\nglobalThis.install = installMobileViewport;'
function fixture() {
  const listeners = new Map(), frames = new Map(), timers = new Map(), values = new Map(); let id=0, focused=false, scrolls=0
  const events = prefix => ({addEventListener:(name,fn)=>listeners.set(prefix+name,fn),removeEventListener:(name)=>listeners.delete(prefix+name)})
  const root={clientHeight:844,dataset:{},style:{setProperty:(k,v)=>values.set(k,v),removeProperty:k=>values.delete(k)}}
  const meta={content:'width=device-width, initial-scale=1',getAttribute(){return this.content},setAttribute(k,v){this.content=v}}
  const visual={...events('visual:'),height:844,scale:1,offsetTop:0}
  const media=q=>({matches:q.includes('780')||q.includes('coarse'),...events(q)})
  const context={innerHeight:844,innerWidth:390,scrollY:0,scrollX:0,visualViewport:visual,screen:{orientation:{type:'portrait-primary'}},navigator:{standalone:true},matchMedia:media,document:{...events('document:'),documentElement:root,querySelector:()=>meta,activeElement:{matches:()=>focused},body:{},},requestAnimationFrame:fn=>{frames.set(++id,fn);return id},cancelAnimationFrame:n=>frames.delete(n),setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:n=>timers.delete(n),scrollTo:()=>{scrolls++;context.scrollY=0},...events('window:')}
  context.window=context;vm.runInNewContext(source,context);const cleanup=context.install()
  const flush=()=>{for(const [key,fn] of [...frames]){frames.delete(key);fn()}}
  const change=(patch,focus=focused)=>{Object.assign(visual,patch);focused=focus;listeners.get('visual:resize')();flush()}
  return {context,visual,root,meta,values,timers,frames,listeners,change,flush,cleanup,scrolls:()=>scrolls}
}
test('mobile zoom policy is set before inputs become available',()=>{const f=fixture();assert.match(f.meta.content,/maximum-scale=1/);assert.match(f.meta.content,/user-scalable=no/);f.cleanup()})
test('keyboard dismissal restores native canvas even while input retains focus',()=>{const f=fixture();f.change({height:400,offsetTop:120},true);assert.equal(f.values.get('--app-viewport-height'),'400px');assert.equal(f.root.dataset.keyboard,'open');f.context.scrollY=120;f.change({height:844,offsetTop:90},true);assert.equal(f.root.dataset.keyboard,'closed');assert.equal(f.values.has('--app-viewport-height'),false);assert.equal(f.values.has('--app-viewport-top'),false);assert.equal(f.scrolls(),1);f.cleanup()})
test('non-unit zoom cannot freeze the previous keyboard geometry',()=>{const f=fixture();f.change({height:400,offsetTop:100},true);f.change({height:844/1.5,scale:1.5},true);assert.equal(f.root.dataset.keyboard,'closed');assert.equal(f.values.size,0);f.cleanup()})
test('blur clears stale reduced geometry before delayed native resize',()=>{const f=fixture();f.change({height:400},true);f.change({height:400},false);assert.equal(f.values.size,0);assert.equal(f.root.dataset.keyboard,'closed');f.cleanup()})
test('rotation replaces the portrait baseline',()=>{const f=fixture();f.change({height:400},true);f.context.innerWidth=844;f.context.innerHeight=390;f.root.clientHeight=390;f.context.screen.orientation.type='landscape-primary';f.change({height:390,offsetTop:0},true);assert.equal(f.root.dataset.keyboard,'closed');f.cleanup()})
test('settling recovery and pageshow clean up all delayed work',()=>{const f=fixture();f.listeners.get('window:focusout')();assert.equal(f.timers.size,3);f.listeners.get('window:pageshow')();assert.equal(f.timers.size,3);f.cleanup();assert.equal(f.timers.size,0);assert.equal(f.frames.size,0);assert.equal(f.values.size,0);assert.equal(f.meta.content,'width=device-width, initial-scale=1')})

test('resizes-content blur and refocus cannot lose the full-height baseline',()=>{const f=fixture();f.context.innerHeight=400;f.root.clientHeight=400;f.change({height:400},true);f.change({height:400},false);f.change({height:400},true);assert.equal(f.root.dataset.keyboard,'open');assert.equal(f.values.get('--app-viewport-height'),'400px');f.context.innerHeight=844;f.root.clientHeight=844;f.change({height:844},true);assert.equal(f.root.dataset.keyboard,'closed');f.cleanup()})
test('scaled keyboard geometry uses visible CSS pixels rather than normalized size',()=>{const f=fixture();f.change({height:400/1.5,scale:1.5,offsetTop:140},true);assert.equal(f.root.dataset.keyboard,'open');assert.equal(f.values.get('--app-viewport-height'),`${400/1.5}px`);assert.equal(f.values.get('--app-viewport-top'),'140px');f.cleanup()})
