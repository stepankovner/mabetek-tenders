import {paragraphs} from './rzd-form-template';

export const original='https://223.rts-tender.ru/files/FileDownloadHandler.ashx?FileGuid=364e6c01-2acd-4dd3-b3fa-18140140ffb7';
const digest='4f254d2ed94e3e5ac4e7944a114fb532b987dd28534ea53b816d4523f34983ca';
export function supportsForm(card:any){
  return card.source==='rzd-rts' && card.procedure==='24233643' && card.registration==='32616584495' && card.documents?.some((d:any)=>d.url.toLowerCase()===original.toLowerCase());
}
export async function verifyOriginal(){
  const r=await fetch(original,{redirect:'error',signal:AbortSignal.timeout(10000)}).catch(()=>null);
  if(!r?.ok || !r.body)return 'unavailable';
  const bytes=new Uint8Array(391168),reader=r.body.getReader();
  let offset=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    if(value.length>bytes.length-offset){await reader.cancel();return 'changed';}
    bytes.set(value,offset);offset+=value.length;
  }
  if(offset!==bytes.length)return r.headers.get('content-type')?.includes('text/html')?'unavailable':'changed';
  const sum=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(sum),n=>n.toString(16).padStart(2,'0')).join('')===digest?'current':'changed';
}

// Stored ZIP entries, with their sizes and CRC in both directory records.
function packageWord(files:Record<string,string>){
  const entries:Uint8Array<ArrayBuffer>[]=[];
  const directory:Uint8Array<ArrayBuffer>[]=[];
  const enc=new TextEncoder();
  let offset=0;
  function record(size:number,signature:number){
    const bytes=new Uint8Array(size),v=new DataView(bytes.buffer);
    v.setUint32(0,signature,true);
    return {bytes,u16:(p:number,n:number)=>v.setUint16(p,n,true),u32:(p:number,n:number)=>v.setUint32(p,n,true)};
  }
  for(const [path,xml] of Object.entries(files)){
    const name=enc.encode(path),data=enc.encode(xml);
    let crc=-1;
    for(const b of data){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(~crc)>>>0;
    const l=record(30,0x04034b50),c=record(46,0x02014b50);
    l.u16(4,20);l.u16(12,33);l.u32(14,crc);l.u32(18,data.length);l.u32(22,data.length);l.u16(26,name.length);
    c.u16(4,20);c.u16(6,20);c.u16(14,33);c.u32(16,crc);c.u32(20,data.length);c.u32(24,data.length);c.u16(28,name.length);c.u32(42,offset);
    entries.push(l.bytes,name,data);directory.push(c.bytes,name);offset+=30+name.length+data.length;
  }
  const end=record(22,0x06054b50),count=Object.keys(files).length;
  end.u16(8,count);end.u16(10,count);end.u32(12,directory.reduce((a,b)=>a+b.length,0));end.u32(16,offset);
  return new Blob([...entries,...directory,end.bytes],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}
export function draftWord(lot:string,vat:string,deliveryTest=false){
  if(lot!=='' && !/^\d{1,9}$/.test(lot))throw Error('Укажите числовой номер лота из оригинала.');
  // Free text can mention several rates, negation or exemptions. Only an explicit affirmative rate is transferable.
  const rate=vat.trim().match(/^(?:ндс\s+)?(100|[1-9]?\d)(?:[.,](\d{1,2}))?\s*%\s*(?:(?:в том числе|включ[её]н(?: в (?:ставку|цену))?)[.!]?)?$/iu);
  const value=rate && Number(rate[1]+'.'+(rate[2]||0))<=100 ? rate[1]+(rate[2]?','+rate[2]:'') : '____';
  const doc='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+(deliveryTest?'ТЕСТ ДОСТАВКИ. Учебные данные. Для подачи не используется. ':'')+'Черновик для проверки владельцем. Извещение 32616584495, лот '+(lot||'____')+'.</w:t></w:r></w:p>'+paragraphs.replace('____',value)+'</w:body></w:document>';
  const file=packageWord({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':doc
  });
  return {file,filled:value!=='____'};
}
