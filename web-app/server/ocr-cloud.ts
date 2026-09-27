import sharp from 'sharp';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { OcrBlock } from './supplier-parser';
const require=createRequire(import.meta.url);
function languagePath(code:'eng'|'osd') {
  return code==='eng' ? require('@tesseract.js-data/eng').langPath : require('@tesseract.js-data/osd').langPath;
}
export async function detectPhotoRotation(raw:Uint8Array) {
  const worker=await createWorker('osd',OEM.TESSERACT_ONLY,{langPath:languagePath('osd'),cacheMethod:'none',legacyCore:true,legacyLang:true});
  const timer=setTimeout(()=>{void worker.terminate();},20000);
  try {const result=await worker.detect(raw);return result.data.orientation_degrees || 0;}
  finally {clearTimeout(timer);await worker.terminate();}
}
export async function recognizeCloudPhoto(raw:Uint8Array,rotation?:number) {
  let worker:Worker|undefined;
  const deadline=setTimeout(()=>{void worker?.terminate();},210000);
  try {
    const normalized=await sharp(raw,{limitInputPixels:40_000_000}).autoOrient().resize({width:3200,height:3200,fit:'inside',withoutEnlargement:true}).png().toBuffer();
    let angle=rotation;
    if(angle===undefined){
      worker=await createWorker('osd',OEM.TESSERACT_ONLY,{langPath:languagePath('osd'),cacheMethod:'none',legacyCore:true,legacyLang:true});
      const detected=await worker.detect(normalized);
      angle=detected.data.orientation_degrees || 0;
      await worker.terminate();worker=undefined;
    }
    const upright=await sharp(normalized).rotate(angle).png().toBuffer();
    const {width,height}=await sharp(upright).metadata();
    worker=await createWorker('eng',OEM.LSTM_ONLY,{langPath:languagePath('eng'),cacheMethod:'none'});
    await worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT,preserve_interword_spaces:'1'});
    const result=await worker.recognize(upright,{}, {blocks:true,text:true});
    const blocks:OcrBlock[]=[];
    for(const block of result.data.blocks || [])for(const paragraph of block.paragraphs)for(const line of paragraph.lines){
      const b=line.bbox;
      if(line.text.trim())blocks.push({text:line.text.trim(),confidence:line.confidence/100,x:b.x0/width!,y:b.y0/height!,width:(b.x1-b.x0)/width!,height:(b.y1-b.y0)/height!});
    }
    const preview=await sharp(upright).resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
    return {preview,blocks,rotation:angle};
  } finally {clearTimeout(deadline);await worker?.terminate();}
}
