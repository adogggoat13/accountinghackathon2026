import http from 'node:http';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseCSV} from './lib/csv.js';
import {analyzeInvoices,runway} from './lib/finance.js';
import {authenticate,checked,importRows} from './lib/supabase.js';
import {uploadDocument,startParse,getParse,saveText} from './lib/documents.js';
import {searchEvidence} from './lib/citations.js';
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>7_100_000)throw Error('Request exceeds 7 MB');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
export function createServer(){return http.createServer(async(req,res)=>{
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 try{
  // Local backend only. Reject browser cross-origin calls; no wildcard CORS.
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Cross-origin requests disabled'});
  const url=new URL(req.url,'http://localhost');const p=url.pathname;
  if(req.method==='GET'&&p==='/api/health')return send(200,{ok:true,mode:'backend-only',supabaseConfigured:Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_PUBLISHABLE_KEY),llamaParseConfigured:Boolean(process.env.LLAMA_CLOUD_API_KEY),note:'Configured does not mean connection verified.'});
  if(req.method==='GET'&&p==='/api/sample')return send(200,analyzeInvoices(parseCSV(await fs.readFile(new URL('./data/invoices.csv',import.meta.url),'utf8'))));
  if(req.method==='POST'&&p==='/api/analyze'){const b=await body(req);return send(200,analyzeInvoices(parseCSV(b.csv),{asOf:b.asOf||'2026-09-30'}));}
  if(req.method==='POST'&&p==='/api/runway')return send(200,runway(await body(req)));
  if(!p.startsWith('/api/'))return send(404,{error:'API-only starter. See README.txt.'});
  const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)return send(401,{error:'Signed-in Supabase user token required'});
  let db;try{db=await authenticate(token);}catch{return send(401,{error:'Supabase configuration or user authentication failed'});}
  if(p==='/api/teams'&&req.method==='GET')return send(200,checked(await db.from('rhb_teams').select('*')));
  if(p==='/api/teams'&&req.method==='POST'){const b=await body(req);if(typeof b.name!=='string'||!b.name.trim())throw Error('Team name required');return send(201,checked(await db.from('rhb_teams').insert({name:b.name}).select().single()));}
  if(p==='/api/members'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||!uuid(b.user_id))throw Error('Valid team and signed-up user UUIDs required');return send(201,checked(await db.from('rhb_members').insert({team_id:b.team_id,user_id:b.user_id}).select()));}
  if(p==='/api/datasets/import'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||typeof b.name!=='string'||b.name.length>100)throw Error('Valid team ID and dataset name required');return send(200,await importRows(db,b.team_id,b.name,parseCSV(b.csv)));}
  if(p==='/api/documents'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||typeof b.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64))throw Error('Team ID and base64 file required');return send(201,await uploadDocument(db,b.team_id,Buffer.from(b.base64,'base64'),b.filename));}
  const match=p.match(/^\/api\/documents\/([0-9a-f-]+)\/(parse|result)$/i);
  if(match){const doc=checked(await db.from('rhb_documents').select('*').eq('id',match[1]).single());
   if(req.method==='POST'&&match[2]==='parse'){
    if(doc.status==='parsed'||doc.status==='parsing')return send(200,{status:doc.status,job_id:doc.parser_job_id});
    const claimed=checked(await db.from('rhb_documents').update({status:'parsing'}).eq('id',doc.id).eq('status',doc.status).select());if(!claimed.length)return send(409,{error:'Another parse is in progress'});
    try{const blob=checked(await db.storage.from('rhb-documents').download(doc.storage_path));
     if(doc.media_type!=='application/pdf')return send(200,await saveText(db,doc,await blob.text()));
     const job=await startParse(Buffer.from(await blob.arrayBuffer()),doc.filename);if(!job.id)throw Error('Parser did not return a job ID');
     checked(await db.from('rhb_documents').update({parser_job_id:job.id}).eq('id',doc.id));return send(202,{status:job.status,job_id:job.id});
    }catch(e){await db.from('rhb_documents').update({status:'failed'}).eq('id',doc.id);throw e;}
   }
   if(req.method==='GET'&&match[2]==='result'){
    if(doc.status==='parsed')return send(200,{status:'parsed',text:doc.parsed_text});
    if(!doc.parser_job_id)return send(200,{status:doc.status});
    const result=await getParse(doc.parser_job_id);
    // Return provider result for explicit schema review; persistence accepts reviewed text via /api/documents/text.
    return send(200,{status:result.job?.status||'unknown',providerResult:result,next:'Review extracted markdown, then POST /api/documents/text with document_id and text.'});
   }
  }
  if(p==='/api/documents/text'&&req.method==='POST'){const b=await body(req);const doc=checked(await db.from('rhb_documents').select('*').eq('id',b.document_id).single());return send(200,await saveText(db,doc,b.text));}
  if(p==='/api/evidence/search'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||typeof b.query!=='string')throw Error('Team and query required');const records=checked(await db.from('rhb_evidence').select('*').eq('team_id',b.team_id).limit(1000));return send(200,{method:'keyword search; no LLM',searched:records.length,limit:1000,results:searchEvidence(records,b.query)});}
  if(p==='/api/findings'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id))throw Error('Team required');return send(201,checked(await db.from('rhb_findings').insert({team_id:b.team_id,title:b.title,detail:b.detail,severity:b.severity,method:b.method,rule:b.rule}).select().single()));}
  return send(404,{error:'Route not found'});
 }catch(error){send(400,{error:error.message});}
});}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){createServer().listen(Number(process.env.PORT)||4180,'127.0.0.1',()=>console.log('Redhawk backend: http://127.0.0.1:'+(process.env.PORT||4180)+'/api/health'));}
