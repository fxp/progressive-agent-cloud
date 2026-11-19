// Provider event IDs alone cannot deduplicate a meeting delivered by two Connectors.
export function meetingIdentity(value){
 let url;try{url=new URL(value);}catch{return null;}
 if(url.protocol!=='https:')return null;
 const minute=/^\/minutes\/([A-Za-z0-9]{12,64})\/?$/.exec(url.pathname)?.[1];
 if(minute&&/^(?:[a-z0-9-]+\.)*feishu\.cn$/.test(url.hostname))return {key:'feishu:minutes:'+minute,lookup:'/minutes/'+minute};
 url.hash='';return {key:url.href,lookup:url.href};
}
