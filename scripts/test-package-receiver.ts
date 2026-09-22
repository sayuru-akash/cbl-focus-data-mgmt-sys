import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'focus-transfer-test-'));
const token='test-only-upload-token';
writeFileSync(join(dir,'session.json'),JSON.stringify({token,expires:Date.now()+60000}));
const proc=Bun.spawn(['bun','web-app/server/package-receiver.ts'],{env:{...process.env,TRANSFER_DIR:dir,TRANSFER_PORT:'0',TRANSFER_HOST:'127.0.0.1'},stdout:'pipe',stderr:'pipe'});
const check=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);console.log('PASS',message)};
try{
 const reader=proc.stdout.getReader();let ready='';while(!ready.includes('listening on port')){const result=await reader.read();if(result.done)throw new Error('Receiver failed to start');ready+=new TextDecoder().decode(result.value)}
 const port=ready.match(/port (\d+)/)![1],base=`http://127.0.0.1:${port}`;
 const send=(body:Uint8Array|string,key=token)=>fetch(base+'/upload',{method:'POST',headers:{Authorization:'Bearer '+key},body});
 check((await send('bad','wrong')).status===401,'Rejects unknown transfer credentials');
 check((await send('not-a-zip')).status===400,'Rejects invalid archives');
 const fixture=join(dir,'fixture.zip');
 const python=Bun.spawn(['python3','-c',`import zipfile,json,sys,io
apk=io.BytesIO()
with zipfile.ZipFile(apk,'w') as z:z.writestr('AndroidManifest.xml','fixture')
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('base.apk',apk.getvalue())
 z.writestr('app-info.json',json.dumps({'package':'test.fixture','label':'Receiver test'}))`,fixture]);check(await python.exited===0,'Builds isolated test fixture');
 const payload=readFileSync(fixture);const response=await send(payload);const result=await response.json();check(response.status===200&&result.received,'Receives validated app package');
 const saved=JSON.parse(readFileSync(join(dir,'received.json'),'utf8'));
 check(createHash('sha256').update(readFileSync(saved.path)).digest('hex')===createHash('sha256').update(payload).digest('hex'),'Preserves uploaded bytes exactly');
 const retry=await(await send(payload)).json();check(retry.received&&retry.duplicate,'Acknowledges exact retry without another file');
 check((await send('different-upload')).status===409,'Session accepts only one different package');
 check((await fetch(base+'/unknown')).status===404,'Does not expose received files');
}finally{proc.kill();await proc.exited;rmSync(dir,{recursive:true,force:true})}
