/** SKN GAS v2. IMPORTANT: no database CRUD here. Stores Drive files and sends MailApp email.
 * Configure Script Properties:
 * SUPABASE_URL  https://PROJECT.supabase.co
 * SUPABASE_PUBLISHABLE_KEY  sb_publishable_... (or legacy anon JWT)
 * SKN_ALLOWED_ORIGINS https://YOUR_USER.github.io,http://localhost:8000
 * SKN_DRIVE_FOLDER_ID  <existing private Drive folder id>
 * Deploy Web App: Execute as Me; Who has access Anyone. Use HTTPS GitHub Pages.
 */
function doGet(){return HtmlService.createHtmlOutput('<p>SKN File Bridge is active.</p>').setTitle('SKN Drive Bridge');}
function doPost(e){
  let response={};let req={};
  try{
    req=JSON.parse(e.parameter.request||'{}');
    const allowed=String(props_().getProperty('SKN_ALLOWED_ORIGINS')||'').split(',').map(x=>x.trim()).filter(Boolean);
    if(!allowed.includes(String(req.origin)))throw Error('Origin ไม่ได้รับอนุญาต');
    response={value:fileOperation(req.jwt,req.action,req.payload)};
  }catch(error){response={error:String(error.message||error)};}
  const origin=String(req.origin||'');
  // Origin and nonce are quoted by JSON.stringify to prevent JavaScript injection.
  const data=JSON.stringify({sknRelay:'response',nonce:String(req.nonce||''),...response}).replace(/</g,'\\u003c');
  const target=JSON.stringify(origin).replace(/</g,'\\u003c');
  const html='<html><body><script>try { window.top.postMessage('+data+','+target+'); } catch(e) { window.parent.postMessage('+data+','+target+'); }</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function props_(){return PropertiesService.getScriptProperties();}
function supa_(path,token,method,body){
 const base=props_().getProperty('SUPABASE_URL');const key=props_().getProperty('SUPABASE_PUBLISHABLE_KEY');
 if(!base||!key)throw Error('Missing Supabase settings in Script Properties');
 const response=UrlFetchApp.fetch(base.replace(/\/$/,'')+path,{
  method:method||'get',muteHttpExceptions:true,contentType:'application/json',headers:{apikey:key,Authorization:'Bearer '+token},
  payload:body!==undefined?JSON.stringify(body):undefined
 });
 if(response.getResponseCode()<200||response.getResponseCode()>=300)throw Error('Supabase ตรวจสิทธิ์ไม่ผ่าน ('+response.getResponseCode()+')');
 return JSON.parse(response.getContentText());
}
function authorize_(token,period,club,action){
 if(!token||String(token).length>5000||!/^[0-9a-f-]{36}$/i.test(String(period)))throw Error('ข้อมูลการยืนยันตัวตนไม่ถูกต้อง');
 const allowed=supa_('/rest/v1/rpc/skn_file_permission',token,'post',{
  p_period:String(period),p_club:String(club||''),p_action:String(action)
 });
 if(allowed!==true)throw Error('ไม่มีสิทธิ์เข้าถึงไฟล์หรือเป็นภาคเรียนย้อนหลัง');
}
function root_(){const id=props_().getProperty('SKN_DRIVE_FOLDER_ID');if(!id)throw Error('Missing SKN_DRIVE_FOLDER_ID');return DriveApp.getFolderById(id);}
function folder_(parts,create){
 let f=root_();for(const part of parts){
  if(!/^[\p{L}\p{N}_. -]{1,130}$/u.test(String(part)))throw Error('Invalid folder');
  const folders=f.getFoldersByName(String(part));if(folders.hasNext())f=folders.next();else if(create)f=f.createFolder(String(part));else return null;
 }return f;
}
function isUnderRoot_(file,rootId){
 const seen={};let q=[];const it=file.getParents();while(it.hasNext())q.push(it.next());
 while(q.length){const f=q.shift();const id=f.getId();if(id===rootId)return true;if(seen[id])continue;seen[id]=true;
  const parents=f.getParents();while(parents.hasNext())q.push(parents.next());}
 return false;
}
function clean_(name){return String(name||'file').replace(/[\\/<>\r\n]/g,'_').slice(0,150);}
function parentIs_(file,expectedFolder){if(!expectedFolder)return false;const it=file.getParents();while(it.hasNext()){if(it.next().getId()===expectedFolder.getId())return true;}return false;}
function fileOperation(jwt,action,payload){
 const p=payload||{};const period=String(p.periodId||'');const club=String(p.clubId||'');
 const permission=(action==='saveBackup'?'backup':action==='getFiles'?'read':action==='sendReportEmail'?'email':'write');
 authorize_(jwt,period,club,permission);
 if(action==='saveFile'){
  const slots=['logo','photo_1','photo_2','photo_3','photo_4','sigTeacher','sigHeadClub','sigHeadDev','sigDeputy','sigDirector','pdf'];
  if(!slots.includes(String(p.slot)))throw Error('Unrecognized file slot');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(club))throw Error('Invalid club ID');
  const mime=String(p.mime||'');
  if(p.slot==='pdf'?mime!=='application/pdf':!['image/png','image/jpeg','image/webp'].includes(mime))throw Error('Invalid file format');
  if(!/^[A-Za-z0-9+/=]+$/.test(String(p.base64||''))||p.base64.length>12000000)throw Error('File too large or damaged');
  const bytes=Utilities.base64Decode(p.base64);if(bytes.length>8500000)throw Error('File exceeds 8.5MB');
  const f=folder_([p.slot==='pdf'?'SKN_PDF_Reports':'SKN_Club_Media',period,club],true);
  const file=f.createFile(Utilities.newBlob(bytes,mime,clean_(p.fileName||p.slot)));
  return {success:true,id:file.getId(),name:file.getName(),url:file.getUrl()};
 }
 if(action==='getFiles'){
  if(!Array.isArray(p.files)||p.files.length>12)throw Error('Too many requested images');
  const files={};
  p.files.forEach(x=>{
   if(!/^(logo|photo_[1-4]|sigTeacher|sigHeadClub|sigHeadDev|sigDeputy|sigDirector)$/.test(x.slot))throw Error('Invalid media slot');
   const registered=supa_('/rest/v1/rpc/skn_file_reference',jwt,'post',{
     p_period:period,p_club:club,p_slot:String(x.slot),p_file_id:String(x.id)
   });
   if(registered!==true)throw Error('รูปนี้ไม่ใช่ไฟล์อ้างอิงของรายงาน');
   const file=DriveApp.getFileById(String(x.id));
   if(!isUnderRoot_(file,root_().getId()))throw Error('File must belong to this Drive installation');
   const blob=file.getBlob();const mime=blob.getContentType();
   if(!['image/png','image/jpeg','image/webp'].includes(mime)||blob.getSize()>3000000)throw Error('Image too large');
   files[x.slot]='data:'+mime+';base64,'+Utilities.base64Encode(blob.getBytes());
  });
  return {success:true,files};
 }
 if(action==='saveBackup'){
  if(typeof p.content!=='string'||p.content.length>25000000)throw Error('JSON backup too large');
  const j=JSON.parse(p.content);
  if(j.format!=='SKN-SUPABASE-V1'||j.period?.id!==period)throw Error('Invalid snapshot period');
  const file=folder_(['SKN_Club_Backups'],true).createFile(Utilities.newBlob(p.content,'application/json',clean_(p.fileName||'SKN-backup.json')));
  return {success:true,id:file.getId(),name:file.getName(),url:file.getUrl()};
 }
 if(action==='sendReportEmail'){
  const email=String(p.email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Invalid email');
  const d=p.data||{};
  const matched=String(d.pdfFile||'').match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
  if(!matched||matched[1].length>12000000)throw Error('Invalid PDF');
  const title=clean_(d.clubName||'ชุมนุม');
  const pdf=Utilities.newBlob(Utilities.base64Decode(matched[1]),'application/pdf','รายงาน_'+title+'.pdf');
  const file=folder_(['SKN_PDF_Reports',period,club],true).createFile(pdf);
  const lines=['สรุปผลการจัดกิจกรรมชุมนุม: '+title,'ครูที่ปรึกษา: '+String(d.teacher||''),
   'นักเรียนทั้งหมด: '+Number(d.totalStudents||0),'ผ่าน: '+Number(d.passCount||0),'ไม่ผ่าน: '+Number(d.failCount||0)];
  MailApp.sendEmail({to:email,subject:'รายงานชุมนุม '+title,body:lines.join('\n'),attachments:[pdf],name:'SKN CLUBS'});
  return {success:true,id:file.getId(),url:file.getUrl()};
 }
 throw Error('Unsupported GAS file operation');
}

/** Run once from the GAS editor to request Google service permissions during deployment. */
function authorizeServices(){
 Logger.log('Drive folder: '+root_().getName());
 Logger.log('MailApp remaining quota: '+MailApp.getRemainingDailyQuota());
 const base=props_().getProperty('SUPABASE_URL');
 if(!base)throw Error('Set SUPABASE_URL');
 const resp=UrlFetchApp.fetch(base.replace(/\/$/,'')+'/auth/v1/health',{
  muteHttpExceptions:true,headers:{apikey:props_().getProperty('SUPABASE_PUBLISHABLE_KEY')||''}
 });
 Logger.log('Supabase Auth status: '+resp.getResponseCode());
}
