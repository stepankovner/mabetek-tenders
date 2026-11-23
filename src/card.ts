import {rzdCard,roseltorgCard,eisOrderCard,eisOrderNumber} from './core.mjs';

export function pendingCardUrl(input:string){
  if(eisOrderNumber(input))return input;
  return /^https:\/\/www\.roseltorg\.ru\/procedure\/[A-Za-z0-9_-]+\/\d+\/?$/.test(input)
    ?input.replace(/\/$/,''):null;
}

export function parseCard(html:string,url:string){
  if(eisOrderNumber(url))return eisOrderCard(html,url);
  if(new URL(url).hostname==='www.roseltorg.ru')return roseltorgCard(html,url);
  return rzdCard(html,url);
}

export async function readCard(input:string){
  const url=new URL(input);
  if(url.username||url.password||url.protocol!=='https:')throw Error('Требуется HTTPS-ссылка на оригинал');
  let canonical;
  const eis=eisOrderNumber(input);
  if(eis){
    canonical=input;
  }else if(url.origin==='https://www.roseltorg.ru' && /^\/procedure\/[\w-]+\/\d+\/?$/.test(url.pathname)){
    canonical=url.origin+url.pathname;
  }else{
    const id=url.searchParams.get('tenderId');
    if(url.origin!=='https://rzd.rts-tender.ru'||url.pathname!=='/TenderInterests/LogViewAndRedirect'||!/^\d{1,16}$/.test(id||''))throw Error('Требуется карточка ЕИС, РЖД или лота Росэлторга');
    canonical='https://rzd.rts-tender.ru/TenderInterests/LogViewAndRedirect?tenderId='+id+'&tenderStatus=RTS_Notification';
  }
  const options={redirect:'manual' as const,signal:AbortSignal.timeout(12000)};
  let res=await fetch(canonical,options);
  if(eis && [301,302,307,308].includes(res.status) && res.headers.has('Location')){
    const next=new URL(res.headers.get('Location')!,canonical).href;
    if(next===canonical||eisOrderNumber(next)!==eis)throw Error('ЕИС перенаправила на другой оригинал');
    await res.body?.cancel();
    res=await fetch(next,options);
    canonical=next;
  }
  if(!res.ok)throw Error('Площадка недоступна или требует входа');
  const reader=res.body!.getReader(), decoder=new TextDecoder();
  let size=0,html='';
  for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>1048576){await reader.cancel();throw Error('Превышен лимит размера');}html+=decoder.decode(p.value,{stream:true});}
  html+=decoder.decode();
  return parseCard(html,canonical);
}
