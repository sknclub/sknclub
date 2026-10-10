/** Paste into OLD spreadsheet-bound Apps Script and run once to export its real data. */
function exportLegacySKN() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const names=['Config','Teachers','Students','Clubs','Registration','Attendance_Data','Club_Reports'];
  const result={format:'SKN-SHEET-EXPORT-V1',sourceSpreadsheetId:ss.getId(),exportedAt:new Date().toISOString(),sheets:{}};
  names.forEach(name=>{
    const sh=ss.getSheetByName(name);if(!sh){result.sheets[name]=[];return;}
    const grid=sh.getDataRange().getDisplayValues();const keys=grid.shift()||[];
    result.sheets[name]=grid.filter(r=>String(r[0]||'').trim()).map(r=>Object.fromEntries(keys.map((k,i)=>[k,String(r[i]??'')])));
  });
  const folder=DriveApp.createFolder('SKN_LEGACY_EXPORT_'+Utilities.formatDate(new Date(),'Asia/Bangkok','yyyyMMdd_HHmmss'));
  const file=folder.createFile(Utilities.newBlob(JSON.stringify(result),'application/json','skn-legacy.json'));
  Logger.log('ดาวน์โหลด JSON จาก: '+file.getUrl());
  Logger.log('ข้อมูลประกอบด้วย: '+names.map(n=>n+': '+result.sheets[n].length).join(', '));
  // PRIVATE: JSON includes legacy plaintext passwords and possibly personal photos.
}
