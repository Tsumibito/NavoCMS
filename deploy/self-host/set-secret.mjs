// Enter values on a hidden local TTY; dotenvx encrypts without plaintext files or argv.
import {createRequire} from 'node:module';
import {readFile,chmod} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
process.umask(0o077);
const [modulePath,file,key,mode]=process.argv.slice(2);
if(!modulePath||!file||!key||!/^([A-Z][A-Z0-9_]*)$/.test(key)||!process.stdin.isTTY||!['--generate',undefined].includes(mode))throw Error('Use a local TTY: node set-secret.mjs <dotenvx-module-path> <env-file> <name> [--generate]');
const root=resolve(modulePath);const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));if(metadata.name!=='@dotenvx/dotenvx')throw Error('Expected installed dotenvx');
const dotenvx=createRequire(join(root,'package.json'))(root);
let value;
if(mode==='--generate')value=randomBytes(32).toString('hex');
else{process.stderr.write('Enter value (hidden), then Enter: ');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');value=await new Promise((yes,no)=>{let buffer='';const read=chunk=>{for(const char of chunk){if(char==='\u0003'){process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();no(Error('Cancelled'));return;}if(char==='\r'||char==='\n'){process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();yes(buffer);return;}if(char==='\u007f')buffer=buffer.slice(0,-1);else if(char>=' ')buffer+=char;}};process.stdin.on('data',read);process.stdin.resume();});process.stderr.write('\n');}
if(!value)throw Error('Empty value');
const target=resolve(file),keys=target+'.keys';
// dotenvx compares with the inherited environment; force a file-based comparison.
const inherited=process.env[key];delete process.env[key];
try{const result=await dotenvx.set(key,value,{path:target,envKeysFile:keys,noArmor:true,noKeychain:true,quiet:true,logLevel:'error'});if(result.processedEnvs.some(row=>row.error))throw Error();if(!(await readFile(target,'utf8')).split('\n').some(line=>line.startsWith(key+'=')))throw Error();await chmod(target,0o600);await chmod(keys,0o600);console.log('Encrypted value saved; keep the local .keys file separate from the encrypted environment.');}catch{throw Error('SECRET_WRITE_FAILED');}finally{value=undefined;if(inherited!==undefined)process.env[key]=inherited;}
