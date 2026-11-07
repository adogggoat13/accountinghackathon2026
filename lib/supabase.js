import {createClient} from '@supabase/supabase-js';
export function client(token,env=process.env){
 if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)throw Error('Configure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
 if(!token)throw Error('Signed-in user access token required');
 return createClient(env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
export function checked({data,error}){if(error)throw Error(error.message);return data;}
export async function authenticate(token){const db=client(token);const {data,error}=await db.auth.getUser(token);if(error||!data.user)throw Error('Invalid or expired access token');return db;}
export async function importRows(db,teamId,name,rows){
 const dataset=checked(await db.from('rhb_datasets').upsert({team_id:teamId,name,source:'Redhawk synthetic pack v1',synthetic:true},{onConflict:'team_id,name'}).select().single());
 for(let offset=0;offset<rows.length;offset+=200){const batch=rows.slice(offset,offset+200).map((r,i)=>({team_id:teamId,dataset_id:dataset.id,record_key:r.record_id||r.id||String(offset+i+2),source_row:offset+i+2,payload:r}));checked(await db.from('rhb_records').upsert(batch,{onConflict:'dataset_id,record_key'}));}
 return {dataset_id:dataset.id,rowsUpserted:rows.length,note:'Upsert is restartable; rows omitted from a later file are not deleted.'};
}
