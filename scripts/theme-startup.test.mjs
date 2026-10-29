import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const source=readFileSync(new URL('../public/theme-init.js',import.meta.url),'utf8')
function boot({cached,dark=false,standalone=false,blocked=false,ios=false,status='default',session=new Map(),rendered=true}={}){
 const root={dataset:{statusBar:status,appearanceRendered:String(rendered)},style:{}};let color,cookie='',reloads=0
 const document={documentElement:root,querySelector:()=>({setAttribute:(_,value)=>color=value,getAttribute:()=>status}),get cookie(){return cookie},set cookie(value){cookie=value}}
 vm.runInNewContext(source,{document,navigator:{standalone,userAgent:ios?'iPhone':''},location:{protocol:'https:',reload:()=>reloads++},sessionStorage:{getItem:k=>session.get(k),setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)},matchMedia:q=>({matches:q.includes('prefers-color-scheme')?dark:standalone}),localStorage:{getItem:()=>{if(blocked)throw Error('Disabled');return cached}}})
 return {root,color,cookie,reloads,session}
}
test('saved dark appearance restores before application startup even with light system appearance',()=>{const {root,color}=boot({cached:'dark'});assert.equal(root.dataset.theme,'dark');assert.equal(root.style.backgroundColor,'#1b1b1d');assert.equal(color,'#1b1b1d')})
test('disabled storage falls back to system appearance without breaking startup',()=>{assert.equal(boot({blocked:true,dark:true}).root.dataset.theme,'dark')})
test('invalid cached values cannot become arbitrary appearance or color values',()=>{const {root,color,cookie}=boot({cached:'unexpected-css-value'});assert.equal(root.dataset.theme,'light');assert.equal(color,'#f0f3f8');assert.match(cookie,/homeworkbook_theme=light;/)})
test('standalone root follows light and dark page appearance',()=>{for(const cached of ['light','dark']){const {root}=boot({cached,standalone:true});assert.equal(root.style.backgroundColor,cached==='light'?'#f0f3f8':'#1b1b1d');assert.equal(root.dataset.standalone,'true')}})
test('system preference stays distinct from its resolved startup color',()=>{for(const dark of [true,false]){const {root}=boot({cached:'system',dark});assert.equal(root.dataset.themePreference,'system');assert.equal(root.dataset.theme,dark?'dark':'light')}})
test('changing startup appearance never reloads an existing PWA',()=>{
 for(const cached of ['light','dark'])assert.equal(boot({cached,standalone:true,ios:true,status:'black-translucent'}).reloads,0)
})
