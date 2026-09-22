import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// A temporary, upload-only receiver. It has no access to inventory authentication.
const dir=resolve(process.env.TRANSFER_DIR||resolve(import.meta.dir,'../data/package-transfer'));
mkdirSync(dir,{recursive:true,mode:0o700});
const sessionFile=resolve(dir,'session.json');
type Session={token:string;expires:number;received?:{path:string;sha256:string;bytes:number;package:string;label:string;received:string}};
let session:Session;
try{session=JSON.parse(readFileSync(sessionFile,'utf8'))}catch{session={token:randomBytes(32).toString('hex'),expires:Date.now()+2*60*60*1000};writeFileSync(sessionFile,JSON.stringify(session),{mode:0o600})}
if(process.argv.includes('--init')){console.log('Temporary upload session initialized.');process.exit(0)}
const limit=256*1024*1024;let uploading=false;
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const server=Bun.serve({hostname:process.env.TRANSFER_HOST||'0.0.0.0',port:Number(process.env.TRANSFER_PORT||4312),maxRequestBodySize:limit,idleTimeout:120,async fetch(req,server){
 const path=new URL(req.url).pathname;
 if(path==='/health')return reply({ready:Date.now()<session.expires});
 if(path==='/status'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(server.requestIP(req)?.address||''))return reply({uploading,received:session.received||null,expired:Date.now()>session.expires});
 if(path!=='/upload'||req.method!=='POST')return reply({error:'Not found'},404);
 const supplied=Buffer.from(req.headers.get('authorization')||''),expected=Buffer.from('Bearer '+session.token);
 if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply({error:'Invalid transfer key'},401);
 if(Date.now()>session.expires)return reply({error:'This transfer session expired. Ask for a refreshed installer.'},410);
 if(uploading)return reply({error:'Another upload is in progress. Retry shortly.'},409);
 if(Number(req.headers.get('content-length')||'0')>limit)return reply({error:'Maximum package size is 256 MB'},413);
 if(!req.body)return reply({error:'No package received'},400);
 uploading=true;const partial=resolve(dir,randomUUID()+'.partial');let bytes=0;const hash=createHash('sha256');
 const fd=openSync(partial,'wx',0o600);closeSync(fd);const writer=Bun.file(partial).writer();
 try{
  const reader=req.body.getReader();try{while(true){const {done,value:chunk}=await reader.read();if(done)break;bytes+=chunk.byteLength;if(bytes>limit)throw new Error('Maximum package size is 256 MB');hash.update(chunk);writer.write(chunk)}}finally{reader.releaseLock()}await writer.end();
  const sha256=hash.digest('hex');
  if(session.received){if(session.received.sha256===sha256){rmSync(partial);return reply({received:true,duplicate:true,sha256})}return reply({error:'An app package has already been received for this session'},409)}
  // Validate the container without extracting or executing its contents.
  const validator=Bun.spawn(['python3','-c',`import json,sys,zipfile,re
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist()
 assert 2<=len(entries)<=100, 'Unexpected archive contents'
 names=[i.filename for i in entries]
 assert len(names)==len(set(names)) and 'base.apk' in names and 'app-info.json' in names, 'Missing app package'
 assert all(re.fullmatch(r'(base|split-[0-9]+)\\.apk|app-info\\.json',n) for n in names), 'Unexpected archive entry'
 assert sum(i.file_size for i in entries)<=1024*1024*1024, 'Archive is too large'
 assert z.getinfo('app-info.json').file_size<=65536, 'Metadata is too large'
 m=json.loads(z.read('app-info.json'))
 assert isinstance(m.get('package'),str) and re.fullmatch(r'[A-Za-z0-9_.]+',m['package']), 'Invalid package name'
 assert isinstance(m.get('label'),str) and len(m['label'])<=200, 'Invalid app label'
 with z.open('base.apk') as f: assert f.read(4)==b'PK\\x03\\x04', 'Base file is not an APK'
 print(json.dumps({'package':m['package'],'label':m['label']}))`,partial],{stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,exit]=await Promise.all([new Response(validator.stdout).text(),new Response(validator.stderr).text(),validator.exited]);
  if(exit!==0){console.error('Rejected invalid app archive');return reply({error:'The upload is not a supported app-package ZIP'},400)}
  const metadata=JSON.parse(stdout);const finalPath=resolve(dir,`app-${sha256.slice(0,16)}.zip`);renameSync(partial,finalPath);
  session.received={path:finalPath,sha256,bytes,package:metadata.package,label:metadata.label,received:new Date().toISOString()};writeFileSync(sessionFile,JSON.stringify(session),{mode:0o600});
  writeFileSync(resolve(dir,'received.json'),JSON.stringify(session.received,null,2),{mode:0o600});
  console.log(JSON.stringify({event:'app-package-received',...session.received}));
  return reply({received:true,sha256,bytes});
 }catch(error){console.error('Package transfer failed:',String(error));return reply({error:bytes>limit?'Package exceeds 256 MB':'Upload interrupted. Tap the app to retry.'},bytes>limit?413:400)}
 finally{try{await writer.end()}catch{}try{rmSync(partial)}catch{}uploading=false}
}});
console.log(`Package receiver listening on port ${server.port}`);
