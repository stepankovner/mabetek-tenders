/* Uses the real worker with SQLite. Only network providers are replaced. */
const assert=require('node:assert/strict');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tender-worker-'));
execFileSync(process.env.TSC||'tsc',['--outDir',tmp,'--target','ES2022','--module','commonjs','--allowJs','--skipLibCheck','src/worker.ts'],{cwd:root});
const worker=require(path.join(tmp,'worker.js')).default;
process.on('exit',()=>fs.rmSync(tmp,{recursive:true,force:true}));

function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const name of fs.readdirSync('migrations').sort())db.exec(fs.readFileSync('migrations/'+name,'utf8'));
  const wrap=(s,params=[])=>({
    bind:(...p)=>wrap(s,p),
    first:async()=>db.prepare(s).get(...params),
    all:async()=>({results:db.prepare(s).all(...params)}),
    run:async()=>db.prepare(s).run(...params)
  });
  return {db,env:{BOT_TOKEN:'fixture',WEBHOOK_SECRET:'test-webhook',AGENT_KEY:'test-Mac',DB:{
    prepare:wrap,batch:async(q)=>{db.exec('BEGIN');try{for(const st of q)await st.run();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
  }}};
}
test('Telegram, D1, очередь Mac и возврат PDF; повтор, изменение, приватность',async()=>{
 const {db,env}=fixture();
 const sent=[],docs=[];
 const card='https://rzd.rts-tender.ru/TenderInterests/LogViewAndRedirect?tenderId=24233643&tenderStatus=RTS_Notification';
 let location='Место указано в техническом задании';
 const original=global.fetch;
 global.fetch=async(url,opts)=>{
   if(String(url)===card){
     const fields={'Наименование':'Погрузка и выгрузка грузов','Заказчик':'Учебный заказчик','Место поставки':location,'Регион':'Хабаровский край','Площадка':'РТС-тендер','Статус на площадке':'Прием заявок','Дата окончания подачи заявок':'24.11.2099 02:00 МСК'};
     return new Response('<table>'+Object.entries(fields).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>');
   }
   if(String(url).endsWith('/sendMessage')){sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:sent.length}});}
   if(String(url).endsWith('/sendDocument')){docs.push(opts.body);return Response.json({ok:true,result:{message_id:128}});}
   throw Error('unexpected provider');
 };
 let seq=0;
 const call=(path,body,headers)=>worker.fetch(new Request('https://test.invalid'+path,{method:'POST',headers,body:typeof body==='string'||body instanceof Buffer?body:JSON.stringify(body)}),env);
 const talk=async(text,user=1,update=++seq)=>call('/telegram',{update_id:update,message:{chat:{type:'private',id:user},from:{id:user},text}},{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET});
 const agent=async(path,body)=> (await call('/agent/'+path,body,{Authorization:'Bearer '+env.AGENT_KEY})).json();
 try{
   assert.equal((await call('/telegram',{},{})).status,403);
   assert.equal((await call('/agent/claim',{},{})).status,403);
   db.prepare('INSERT INTO pairing VALUES(?,unixepoch()+300)').run(crypto.createHash('sha256').update('fixture-pairing').digest('hex'));
   await talk('/start fixture-pairing');
   await talk('/start fixture-pairing',2);
   assert.equal(sent.length,1);
   await talk('/watch '+card);const n=sent.length;await talk('/watch '+card,1,seq);assert.equal(sent.length,n);
   const liveCard=sent.at(-1);
   const docsButton=liveCard.reply_markup.inline_keyboard.flat().find(b=>b.text==='Документы');
   assert.ok(docsButton);
   await talk(docsButton.callback_data);
   assert.match(sent.at(-1).text,/приложени/i);
   await talk('/analyze 1 1');await talk('/analyze 1 1');
   const job=await agent('claim',{});assert.equal(job.op,'analysis');assert.equal(await agent('claim',{}),null);
   await agent('result',{id:job.id,lease:job.lease,text:'результат'});
   await talk('/terms 1 1');
   for(const input of ['Выгрузка','1.5','т','3.33','без НДС','1 декабря','после акта','25 ноября','1'])await talk(input);
   const approval=sent.at(-1);assert.match(approval.text,/5.00 ₽/);
   await talk(approval.reply_markup.inline_keyboard[0][0].callback_data);
   const pdfJob=await agent('claim',{});assert.match(pdfJob.op,/^pdf\//);
   const pdf=Buffer.from('%PDF-1.7\nfixture');
   const headers={Authorization:'Bearer '+env.AGENT_KEY,'x-job':String(pdfJob.id),'x-lease':pdfJob.lease};
   assert.equal((await call('/agent/pdf',pdf,headers)).status,200);
   assert.equal(docs.length,1);
   assert.equal((await call('/agent/pdf',pdf,headers)).status,409);
   await talk('/terms 1 1');location='Другая площадка';await talk('/watch '+card);
   await talk('ответ старой версии');assert.match(sent.at(-1).text,/обновился/);
   assert.equal(db.prepare('select state from offers').get().state,'устарело');
 }finally{global.fetch=original;db.close();}
});
test('Registration accepts same-site form with opaque Origin but requires the agent key',async()=>{
  const {env,db}=fixture();
  try{
    const make=(origin,site)=>new Request('https://test.invalid/setup',{method:'POST',headers:{origin,'sec-fetch-site':site},body:new URLSearchParams({key:'wrong'})});
    assert.equal(await (await worker.fetch(make('null','same-origin'),env)).text(),'Доступ запрещён');
    assert.equal(await (await worker.fetch(make('https://other.invalid','cross-site'),env)).text(),'Недоступно');
  }finally{db.close();}
});
test('B2B stores one notice from a tracked catalogue URL and honors Retry-After',async()=>{
  const {db,env}=fixture();
  db.exec("INSERT INTO owner(id) VALUES('1')");
  const monitor=require(path.join(tmp,'monitor.js'));
  const previous=global.fetch;
  const slug='/market/pogruzka-vagonov/tender-1234567/';
  let limited=true;
  global.fetch=async url=>{
    if(limited)return new Response(null,{status:429,headers:{'Retry-After':'2400'}});
    if(String(url).includes('market-search'))return new Response('<a href="'+slug+'#btid=2"></a><a href="'+slug+'">№ 1234567</a>');
    assert.equal(url,'https://www.b2b-center.ru'+slug);
    return new Response('<title>Погрузка вагонов — Тендер № 1234567 — B2B-Center</title>');
  };
  try{
    await monitor.b2b(env);
    assert.ok(db.prepare("SELECT next_at-unixepoch() AS delay FROM sources WHERE id='b2b'").get().delay>=2399);
    limited=false;
    for(let i=0;i<2;i++){
      db.exec("UPDATE sources SET next_at=0 WHERE id='b2b'");
      await monitor.b2b(env);
    }
    assert.equal(db.prepare('SELECT title FROM notices').get().title,'Погрузка вагонов');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,1);
    assert.equal(db.prepare("SELECT last_error FROM sources WHERE id='b2b'").get().last_error,null);
  }finally{global.fetch=previous;db.close();}
});
test('Scheduled EIS poll sends a matching notice once and skips unrelated supplies',async()=>{
 const {db,env}=fixture();
 db.exec("INSERT INTO owner(id) VALUES('1')");
 const previous=global.fetch, sent=[];
 const items=['Услуги по выгрузке вагонов в Хабаровске','Поставка железнодорожных колёс в Хабаровск'];
 global.fetch=async(url,opts)=>{
   if(String(url).startsWith('https://zakupki.gov.ru/')) return new Response('<rss><channel>'+items.map((title,i)=>'<item><link>https://zakupki.gov.ru/'+i+'</link><title>'+title+'</title></item>').join('')+'</channel></rss>');
   if(String(url).endsWith('/sendMessage')){sent.push(JSON.parse(opts.body).text);return Response.json({ok:true,result:{message_id:55}});}
   return new Response('',{status:503});
 };
 try{
   for(let i=0;i<2;i++){db.exec("UPDATE sources SET next_at=0");await worker.scheduled({},env);}
   assert.equal(sent.length,1);
   assert.match(sent[0],/выгрузке вагонов/);
   assert.equal(db.prepare('SELECT count(*) n FROM notices').get().n,2);
 }finally{global.fetch=previous;db.close();}
});
test('Semantic queue survives quota errors, caches profile and updates edited notices',async()=>{
 const {db,env}=fixture();
 const {rankNotices}=require(path.join(tmp,'semantic.js'));
 db.prepare("INSERT INTO notices(url,title,updated) VALUES(?,?,1)").run('https://zakupki.gov.ru/a','Приём гружёных вагонов');
 const calls=[];
 let down=true;
 env.AI={run:async(model,args)=>{calls.push(args.text);if(down)throw Error('quota');return {data:args.text.map((s,i)=>[1,1+i])};}};
 try{
   await rankNotices(env);assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_results').get().n,0);
   down=false;
   await rankNotices(env);assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_results').get().n,1);
   const n=calls.length;
   await rankNotices(env);assert.equal(calls.length,n);
   db.exec("UPDATE notices SET updated=2,title='Уточнённый предмет'");
   await rankNotices(env);
   assert.equal(calls.length,n+1);assert.equal(calls.at(-1).length,1);
   assert.equal(db.prepare('SELECT source_updated FROM semantic_results').get().source_updated,2);
 }finally{db.close();}
});
test('Publish smoke reports its revision and permits live polling only to the Mac owner',async()=>{
 const {db,env}=fixture();
 env.RELEASE='test-revision';
 const previous=global.fetch;
 global.fetch=async()=>new Response('',{status:503});
 try{
   const health=await worker.fetch(new Request('https://example.test/health'),env);
   assert.equal((await health.json()).release,'test-revision');
   const check=key=>worker.fetch(new Request('https://example.test/agent/check',{method:'POST',headers:{Authorization:'Bearer '+key},body:'{}'}),env);
   assert.equal((await check('wrong')).status,403);
   const res=await check(env.AGENT_KEY);
   const status=await res.json();
   assert.equal(status.sources.length,5);
   assert.ok(status.sources.every(s=>s.last_error&&!s.last_ok));
 } finally{db.close();global.fetch=previous;}
});
