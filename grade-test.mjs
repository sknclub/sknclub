import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const a=html.match(/countStatus\(stdId, type\)\s*\{([^}]+)\}/);
const b=html.match(/calculateGrade\(stdId\)\s*\{([\s\S]*?)\n\s*\},\s*\n\s*countPass\(\)/);
assert(a&&b,'Cannot find exact original grade methods');
const methods=`({countStatus(stdId,type){${a[1]}},calculateGrade(stdId){${b[1]}}})`;
const system=vm.runInNewContext(methods);
function run(arr){system.attData={records:{test:arr}};return system.calculateGrade('test');}
assert.equal(run(Array(20).fill(0)),'ไม่ผ่าน');
assert.equal(run([1,3,3,3,...Array(16).fill(0)]),'ผ่าน');
assert.equal(run([1,3,3,3,3,...Array(15).fill(0)]),'ไม่ผ่าน');
assert.equal(run(Array(20).fill(1)),'ผ่าน');
assert.equal(run([2,...Array(19).fill(0)]),'ไม่ผ่าน');
console.log('PASS: five original 20-session attendance grade cases');
