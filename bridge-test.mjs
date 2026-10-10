import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const script=fs.readFileSync(new URL('../web/bridge.js',import.meta.url),'utf8');
const store=new Map();const methods=[];
const fake={auth:{signOut:async()=>({error:null})}};
const callbacks=new Map();
const env={console,Error,Promise,Map,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'fcc93d6f-3333-4444-a555-bf42b9bc394e'},
 sessionStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 location:{origin:'https://example.github.io',href:'https://example.github.io/school/'},
 window:{SKN_CONFIG:{supabaseUrl:'https://example.supabase.co',publishableKey:'publishable-test',gasWebAppUrl:'https://script.google.com/macros/s/test/exec'},
  supabase:{createClient:()=>fake},addEventListener:(type,fn)=>callbacks.set(type,fn),SKNBackend:{invoke:async(method,args,period)=>{methods.push([method,args,period]);return {ok:true};}}}};
vm.runInNewContext(script,env);
assert.equal(env.window.SKN_DB,fake);
const result=await new Promise((resolve,reject)=>env.window.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).getAppData());
assert.equal(result.ok,true);assert.equal(methods[0][0],'getAppData');
env.window.SKNBridge.periodId='year-2569-term-2';
await env.window.SKNBridge.invoke('getAdminSummary',[]);
assert.equal(methods[1][2],'year-2569-term-2');
env.window.SKNBridge.logout();assert.equal(env.window.SKNBridge.periodId,'');
console.log('PASS: no Edge URL, direct backend bridge, selectable period, logout');
