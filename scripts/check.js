import {authenticate,checked} from '../lib/supabase.js';
console.log('Node',process.version);
if(!process.env.SUPABASE_ACCESS_TOKEN){console.log('Offline mode. Configure Supabase URL, publishable key and signed-in user token to verify a live connection.');process.exit(0);}
try{const db=await authenticate(process.env.SUPABASE_ACCESS_TOKEN);const teams=checked(await db.from('rhb_teams').select('id,name'));console.log('Authenticated and queried baseline schema. Visible teams:',teams.length);}catch(e){console.error('Live check failed:',e.message);process.exitCode=1;}
