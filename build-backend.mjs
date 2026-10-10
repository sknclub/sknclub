/** Convert frontend backend.ts to backend.js. Run `npm install && npm run build`. */
import fs from 'node:fs';
import ts from 'typescript';
const src='web/backend.ts';
const result=ts.transpileModule(fs.readFileSync(src,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},reportDiagnostics:true});
if(result.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error)){
 for(const d of result.diagnostics)console.error(ts.flattenDiagnosticMessageText(d.messageText,'\n'));
 process.exit(1);
}
fs.writeFileSync('web/backend.js',result.outputText);
console.log('Built web/backend.js');
