import {resolve} from 'node:path';
const names=['DATABASE_URL','DATABASE_URL_POOLED','APP_URL','SECURE_COOKIES','OCR_ENGINE','R2_BUCKET','R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','CRON_SECRET',...(process.env.OCR_ENGINE==='cloudflare'?['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_AI_TOKEN','CLOUDFLARE_AI_MODEL']:[])];
for(const name of names){
 const value=process.env[name];if(!value)throw new Error(`Missing ${name}`);
 const child=Bun.spawn(['vercel','env','add',name,'production','--force','--yes'],{cwd:resolve(import.meta.dir,'../..'),stdin:new Blob([value]),stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 if(code)throw new Error(`Vercel could not configure ${name}: ${out.replaceAll(value,'[redacted]')} ${err.replaceAll(value,'[redacted]')}`);
 console.log(`${name} configured`);
}
