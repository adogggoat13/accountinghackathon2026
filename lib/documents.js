import {requestJSON} from './sources.js';
import {sha256,chunks} from './citations.js';
import {checked} from './supabase.js';
export function validateDocument(bytes,filename){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>5242880)throw Error('Document must be 1 byte to 5 MB');
 if(!/^[A-Za-z0-9_. -]{1,100}$/.test(filename)||filename.includes('..'))throw Error('Use a simple filename');
 const ext=filename.split('.').pop().toLowerCase();if(!['pdf','txt','csv'].includes(ext))throw Error('Use PDF, TXT or CSV');
 if(ext==='pdf'&&bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF header');
 return ext==='pdf'?'application/pdf':ext==='csv'?'text/csv':'text/plain';
}
export async function uploadDocument(db,teamId,bytes,filename){
 const media=validateDocument(bytes,filename),hash=sha256(bytes),storagePath=`${teamId}/${hash}/${filename}`;
 const old=checked(await db.from('rhb_documents').select('*').eq('team_id',teamId).eq('sha256',hash).maybeSingle());if(old)return old;
 checked(await db.storage.from('rhb-documents').upload(storagePath,bytes,{contentType:media,upsert:false}));
 const doc=await db.from('rhb_documents').insert({team_id:teamId,filename,storage_path:storagePath,sha256:hash,media_type:media}).select().single();
 if(doc.error){await db.storage.from('rhb-documents').remove([storagePath]);throw Error(doc.error.message);}return doc.data;
}
export async function startParse(bytes,filename,{key=process.env.LLAMA_CLOUD_API_KEY,fetcher=fetch}={}){
 const media=validateDocument(bytes,filename);if(!key)throw Error('LLAMA_CLOUD_API_KEY required');
 const form=new FormData();form.append('file',new Blob([bytes],{type:media}),filename);form.append('configuration',JSON.stringify({tier:'fast',version:'2026-06-15'}));
 return requestJSON('https://api.cloud.llamaindex.ai/api/v2/parse/upload',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form},fetcher);
}
export function getParse(jobId,{key=process.env.LLAMA_CLOUD_API_KEY,fetcher=fetch}={}){
 if(!/^[a-zA-Z0-9-]+$/.test(jobId)||!key)throw Error('Valid job ID and LlamaParse key required');
 return requestJSON(`https://api.cloud.llamaindex.ai/api/v2/parse/${jobId}?expand=markdown`,{headers:{Authorization:`Bearer ${key}`}},fetcher);
}
export async function saveText(db,document,text){
 if(typeof text!=='string'||text.length>2_000_000)throw Error('Parsed text exceeds 2 million characters');
 const evidence=chunks(text).map(c=>({start_offset:c.start,end_offset:c.end,quote:c.quote}));
 return checked(await db.rpc('rhb_save_document_text',{p_document_id:document.id,p_text:text,p_chunks:evidence}));
}
