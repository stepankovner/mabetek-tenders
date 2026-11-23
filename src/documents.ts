import {catalogueMatch,construction,eisOrderNumber,infrastructureOnly,khabarovskLocation} from './core.mjs';

export interface FileRecord { url:string; name:string; sha256:string|null }
export interface FormField { label:string; field:string; fillable:boolean }
export interface FormInfo extends FileRecord { fields:FormField[] }
export interface Excerpt { file:string; quote:string; location?:string }
export interface Review {
  digest:string|null; complete:boolean; parsed:boolean; files:FileRecord[];
  places:Excerpt[]; services:Excerpt[]; forms:FormInfo[]; notes:string[];
}
const sha=/^[0-9a-f]{64}$/;
const publicFile=/^https:\/\/(?:zakupki\.gov\.ru\/(?:223\/filestore\/public\/1\.0\/download\/fz223|44fz\/filestore\/public\/1\.0\/download\/priz)\/file\.html\?uid=[a-f0-9]{32}|223\.rts-tender\.ru\/files\/FileDownloadHandler\.ashx\?FileGuid=[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const transferFields=new Set(['lot','service','qty','unit','rate','terms','dates','validity','vat_percent','vat','manual']);
const bounded=(value:any,n:number)=>typeof value==='string'&&value.length<=n;

export function documentKey(url:string){
  const number=eisOrderNumber(url);
  return number?'eis:'+number:/^https:\/\/rzd\.rts-tender\.ru\/TenderInterests\/LogViewAndRedirect\?tenderId=\d{1,16}&tenderStatus=RTS_Notification$/.test(url)?url:null;
}

export function queueDocuments(e:any,url:string,watched=false,urgent=false){
  const key=documentKey(url);
  if(!key)return null;
  return e.DB.prepare(
    'INSERT INTO document_tasks(key,url,watched) VALUES(?,?,?) '+
    'ON CONFLICT(key) DO UPDATE SET watched=max(watched,excluded.watched),url=CASE WHEN excluded.watched THEN excluded.url ELSE url END,'+
    'due=CASE WHEN ? THEN min(due,unixepoch()) ELSE due END'
  ).bind(key,url,Number(watched),Number(urgent));
}

export function validatedReview(body:any):Review|null{
  if(!body||typeof body.complete!=='boolean'||typeof body.parsed!=='boolean'
    ||!Array.isArray(body.files)||body.files.length>12||!Array.isArray(body.forms)||body.forms.length>10
    ||!Array.isArray(body.places)||body.places.length>16||!Array.isArray(body.services)||body.services.length>20
    ||!Array.isArray(body.notes)||body.notes.length>12||!body.notes.every((n:any)=>bounded(n,1300)))return null;
  const files=new Map<string,FileRecord>();
  for(const row of body.files){
    if(!row||!bounded(row.name,220)||!row.name||!bounded(row.url,300)||!publicFile.test(row.url)
      ||files.has(row.url)||(row.sha256!==null&&(!bounded(row.sha256,64)||!sha.test(row.sha256))))return null;
    files.set(row.url,{name:row.name,url:row.url,sha256:row.sha256});
  }
  if(body.complete?(typeof body.digest!=='string'||!sha.test(body.digest)||[...files.values()].some(f=>!f.sha256)):body.digest!==null)return null;
  const names=new Set([...files.values()].map(f=>f.name));
  const excerpt=(item:any)=>item&&names.has(item.file)&&bounded(item.quote,360)&&item.quote
    &&(item.location===undefined||bounded(item.location,100));
  if(![...body.places,...body.services].every(excerpt))return null;
  const forms:FormInfo[]=[];
  for(const form of body.forms){
    const file=files.get(form?.url);
    if(!file?.sha256||form.name!==file.name||form.sha256!==file.sha256||!Array.isArray(form.fields)||form.fields.length>40)return null;
    const fields:FormField[]=[];
    for(const field of form.fields){
      if(!field||!bounded(field.label,100)||!transferFields.has(field.field)||typeof field.fillable!=='boolean'
        ||(field.field==='manual'&&field.fillable))return null;
      fields.push({label:field.label,field:field.field,fillable:field.fillable});
    }
    if(forms.some(f=>f.url===file.url))return null;
    forms.push({...file,fields});
  }
  return {digest:body.digest,complete:body.complete,parsed:body.parsed,files:[...files.values()],
    places:body.places.map(({file,quote}:Excerpt)=>({file,quote})),
    services:body.services.map(({file,quote,location}:Excerpt)=>({file,quote,location})),
    forms,notes:body.notes};
}

export function documentMatch(card:any, review:Review){
  if(!review.complete||!review.parsed||!review.places.length)return null;
  if(construction.test(card.title)||infrastructureOnly(card.title))return null;
  const workPlaces=review.places.map(item=>({item,place:item.quote.match(
    /мест[оа]\s+(?:выполнения работ|оказания услуг|исполнения)(?:[^:\n]{0,20})[:—–-]?\s*(.+)/iu)?.[1]||''}));
  // A confirmed conflicting site in the original or any readable document
  // requires manual review instead of a priority notification.
  if((card.place&&!khabarovskLocation('',card.place))
     ||workPlaces.some(({place})=>!place||!khabarovskLocation('',place)
        ||/ванино|владивосток|комсомольск|биробиджан|сахалин|буряти|якут|москв/iu.test(place)))return null;
  for(const {item} of workPlaces){
    const service=review.services.find(s=>s.file===item.file&&catalogueMatch(s.quote));
    if(catalogueMatch(card.title)||service)return {location:item.quote,service};
  }
  return null;
}

export function formSummary(review:Review){
  return review.forms.map((form,i)=>{
    const fillable=form.fields.filter(f=>f.fillable).map(f=>f.label);
    const manual=form.fields.filter(f=>!f.fillable).map(f=>f.label);
    return [form.name,fillable.length?'Можно перенести: '+[...new Set(fillable)].join(', '):'Заполняется вручную.',
      manual.length?'Проверить или заполнить вручную: '+[...new Set(manual)].join(', '):'Проверьте остальные поля, подпись и приложения.'].join('\n');
  }).join('\n\n');
}
