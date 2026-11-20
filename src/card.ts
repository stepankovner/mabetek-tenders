import {rzdCard} from './core.mjs';
export async function readRzd(input:string){
  const url=new URL(input);
  const id=url.searchParams.get('tenderId');
  if(url.origin!=='https://rzd.rts-tender.ru'||url.username||url.password||url.pathname!=='/TenderInterests/LogViewAndRedirect'||!/^\d{1,16}$/.test(id||''))throw Error('Требуется ссылка на карточку РЖД');
  const canonical='https://rzd.rts-tender.ru/TenderInterests/LogViewAndRedirect?tenderId='+id+'&tenderStatus=RTS_Notification';
  const res=await fetch(canonical,{redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(!res.ok)throw Error('Площадка недоступна или требует входа');
  const reader=res.body!.getReader(), decoder=new TextDecoder();
  let size=0,html='';
  for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>1048576){await reader.cancel();throw Error('Превышен лимит размера');}html+=decoder.decode(p.value,{stream:true});}
  return rzdCard(html+decoder.decode(),canonical);
}
