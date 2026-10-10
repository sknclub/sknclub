/* Compatibility with the legacy Vue page; zero Edge Functions and zero service-role keys.
   Database calls: window.SKN_DB (Supabase JS client) -> PostgREST/RPC and RLS.
   File calls: only GAS HTMLService iframe -> Drive/MailApp (JWT verified in GAS). */
(()=>{
  'use strict';
  const c=window.SKN_CONFIG||{};
  if(!c.supabaseUrl || !c.publishableKey || c.supabaseUrl.includes('YOUR_')) {
    console.warn('Configure web/config.js before installing SKN Clubs.');
  }
  window.SKN_DB=window.supabase.createClient(c.supabaseUrl,c.publishableKey,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
  const periodKey='skn_period_v3';
  const bridge={
    get periodId(){return sessionStorage.getItem(periodKey)||'';},
    set periodId(v){if(v)sessionStorage.setItem(periodKey,v);else sessionStorage.removeItem(periodKey);},
    async logout(){sessionStorage.removeItem(periodKey);try{await window.SKN_DB.rpc('skn_logout');}catch(e){console.warn('Session revoke failed',e);}finally{await window.SKN_DB.auth.signOut().catch(console.warn);}},
    invoke(method,args){return window.SKNBackend.invoke(method,args,this.periodId);}
  };
  window.SKNBridge=bridge;
  // Browser-to-GAS POST uses an ordinary hidden form/iframe (no CORS preflight).
  // GAS returns HtmlService with postMessage; a one-time nonce authenticates the response.
  const pending=new Map();
  window.addEventListener('message',event=>{
    const origin=event.origin||'';
    if(origin!=='null'&&!/^https:\/\/(?:script\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/i.test(origin))return;
    const d=event.data;
    if(!d||d.sknRelay!=='response'||!pending.has(d.nonce))return;
    const rec=pending.get(d.nonce);pending.delete(d.nonce);clearTimeout(rec.timer);
    rec.frame.remove();rec.form.remove();
    if(d.error)rec.reject(Error(d.error));else rec.resolve(d.value);
  });
  window.SKNFile={async invoke(action,payload){
    if(!c.gasWebAppUrl||c.gasWebAppUrl.includes('YOUR_'))throw Error('กรุณาตั้งค่า GAS Web App URL');
    const {data:{session}}=await window.SKN_DB.auth.getSession();
    if(!session?.access_token)throw Error('กรุณาเข้าสู่ระบบใหม่');
    const nonce=crypto.randomUUID();const frame=document.createElement('iframe');
    frame.name='skn_file_'+nonce.replace(/-/g,'');
    frame.title='SKN file upload';
    frame.style.cssText='position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0';
    const form=document.createElement('form');
    form.method='POST';form.action=c.gasWebAppUrl;form.target=frame.name;
    form.enctype='application/x-www-form-urlencoded';form.style.display='none';
    const input=document.createElement('input');input.type='hidden';input.name='request';
    input.value=JSON.stringify({jwt:session.access_token,action,payload,nonce,origin:location.origin});
    form.appendChild(input);document.body.appendChild(frame);document.body.appendChild(form);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(nonce);frame.remove();form.remove();reject(Error('GAS ไม่ตอบกลับ: ตรวจสอบสิทธิ์ Deploy และ Google Drive'))},60000);
      pending.set(nonce,{resolve,reject,timer,frame,form});form.submit();
    });
  }};
  const run=(ok,fail)=>new Proxy({withSuccessHandler:fn=>run(fn,fail),withFailureHandler:fn=>run(ok,fn)},
   {get(t,prop){if(prop in t)return t[prop];if(typeof prop!=='string'||prop==='then')return undefined;
    return (...args)=>bridge.invoke(prop,args).then(value=>ok?.(value)).catch(e=>{
     if(fail)fail(e.message||String(e));else {console.error('SKN',prop,e);window.Swal?.fire('ระบบขัดข้อง',e.message||String(e),'error');}
    });}});
  window.google=window.google||{};window.google.script={run:run(null,null)};
})();
