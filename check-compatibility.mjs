import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url).pathname;
const html=fs.readFileSync(root+'web/index.html','utf8');
const vue=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>'));
new vm.Script(vue,{filename:'index.html (Vue.js)'});
const backend=fs.readFileSync(root+'web/backend.ts','utf8');
const exposed=new Set([...backend.matchAll(/case '([\w]+)'/g)].map(x=>x[1]));
for(const name of ['checkLogin','getAppData','getAdminSummary','registerClub','getClubAttendanceGrid',
 'saveAttendanceGrid','getGlobalFailedSummary','findStudentClub','getStudentsByRoom',
 'getUsersByRole','saveUser','deleteUser','deleteClubAdmin','deleteStudentsBulkServer',
 'importUsersFromCSV','saveClub','updateClub','saveClubReportData','getSavedClubReport',
 'sendClubReportEmail','startNewSemester','getBackupFilesList','saveAdvancedSystemSettings','savePdfToDrive']) {
 assert(exposed.has(name)||name==='checkLogin',`Missing ${name}`);
}
assert(html.includes("@click=\"chooseSignature('sigTeacher')\""));
assert(html.includes('๓. กำหนดวันที่จัดกิจกรรมชุมนุม'));
assert(html.includes('๔. กำหนดวันหยุด'));
assert(html.indexOf('๓. กำหนดวันที่จัดกิจกรรมชุมนุม')<html.indexOf('๔. กำหนดวันหยุด'));
assert(html.includes('copyTeachers: true')&&html.includes('copyRegistrations: true'));
assert(html.includes("reader.readAsText(file)"),'CSV upload must read browser-selected file');
assert(backend.includes('present===0||absent>3'),'Original grading criteria changed');
assert(backend.includes("db.rpc('skn_register'"),'Atomic registration RPC missing');
assert(backend.includes("db.rpc('skn_create_period'"),'Atomic term copy RPC missing');
assert(!backend.includes('Deno.serve'),'Edge Function runtime must be removed');
const script=fs.readFileSync(root+'web/bridge.js','utf8');new vm.Script(script);
const sql=fs.readFileSync(root+'supabase/migrations/202610100002_browser_direct.sql','utf8');
for(const r of ['skn_prepare_login','skn_bind_auth','skn_save_attendance','skn_create_period','skn_file_permission','skn_file_reference'])assert(sql.includes(r),`Missing SQL: ${r}`);
assert(!script.includes('service_role')&&!backend.includes('SUPABASE_SERVICE_ROLE_KEY'));
console.log('PASS: Vue syntax, 23 methods, CSV, direct Supabase, RLS/RPC, copy options, signatures');
