import {createHash} from 'node:crypto';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function chunks(text,{size=1600,overlap=200}={}){
 if(typeof text!=='string'||!Number.isInteger(size)||size<10||!Number.isInteger(overlap)||overlap<0||overlap>=size)throw Error('Invalid chunk settings');
 const result=[];for(let start=0;start<text.length;start+=size-overlap){const end=Math.min(start+size,text.length);result.push({start,end,quote:text.slice(start,end),sha256:sha256(text.slice(start,end))});if(end===text.length)break;}return result;
}
export function verifyCitation(text,{start,end,quote}){return Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=text.length&&text.slice(start,end)===quote;}
// Keyword retrieval only. No embeddings or LLM implementation.
export function searchEvidence(evidence,query,limit=5){const words=[...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g)||[])];return evidence.map(e=>({...e,score:words.filter(w=>e.quote.toLowerCase().includes(w)).length})).filter(e=>e.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);}
