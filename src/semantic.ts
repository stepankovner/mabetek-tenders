const model='@cf/baai/bge-m3';
const scenarios=[
  'Исполнитель предоставляет в Хабаровске железнодорожный путь для приёма вагонов, временной постановки или аренды.',
  'Погрузка, выгрузка и перевалка грузов с вагонов на площадке исполнителя в Хабаровске.',
  'Хранение грузов на складе с железнодорожным подъездным путём, временное размещение на открытой площадке.'
];
const profile=scenarios.join('\n');
async function digest(text:string){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
function cosine(a:number[],b:number[]){
  if(!a.length||a.length!==b.length)throw Error('Размер эмбеддинга изменился');
  let product=0,normA=0,normB=0;
  for(let i=0;i<a.length;i++){product+=a[i]*b[i];normA+=a[i]*a[i];normB+=b[i]*b[i];}
  const score=product/Math.sqrt(normA*normB);
  if(!Number.isFinite(score))throw Error('Некорректный эмбеддинг');
  return score;
}
export async function rankNotices(e:any){
  if(!e.AI)return;
  const q=(s:string,...params:unknown[])=>e.DB.prepare(s).bind(...params);
  const version=await digest(profile);
  const {results}=await q('SELECT n.* FROM notices n LEFT JOIN semantic_results r ON n.url=r.url WHERE r.url IS NULL OR n.updated!=r.source_updated OR r.model!=? OR r.profile!=? ORDER BY n.updated,n.url LIMIT 3',model,version).all();
  if(!results.length)return;
  const texts=[...scenarios,...results.map((r:any)=>(r.title+' '+(r.description||'')).slice(0,1400))];
  const hashes=await Promise.all(texts.map(digest));
  const vectors=new Map<string,number[]>();
  const missing=new Map<string,string>();
  for(let i=0;i<texts.length;i++){
    const cached=await q('SELECT vector FROM embedding_cache WHERE model=? AND digest=?',model,hashes[i]).first();
    if(cached)vectors.set(hashes[i],JSON.parse(cached.vector));
    else missing.set(hashes[i],texts[i]);
  }
  const changes=[];
  if(missing.size){
    let answer;
    try{answer=await e.AI.run(model,{text:[...missing.values()]});}
    catch{return;}
    if(!Array.isArray(answer.data)||answer.data.length!==missing.size)return;
    let i=0;
    for(const key of missing.keys()){
      const vector=answer.data[i++];
      if(!Array.isArray(vector)||!vector.length||!vector.every(Number.isFinite))return;
      vectors.set(key,vector);
      changes.push(q('INSERT OR IGNORE INTO embedding_cache VALUES(?,?,?)',model,key,JSON.stringify(vector)));
    }
  }
  for(let i=0;i<results.length;i++){
    const vector=vectors.get(hashes[scenarios.length+i])!;
    const scores=scenarios.map((_,j)=>cosine(vector,vectors.get(hashes[j])!));
    const score=Math.max(...scores);
    changes.push(q('INSERT OR REPLACE INTO semantic_results(url,model,profile,source_updated,score,scenario) VALUES(?,?,?,?,?,?)',results[i].url,model,version,results[i].updated,score,scenarios[scores.indexOf(score)]));
  }
  await e.DB.batch(changes);
}
