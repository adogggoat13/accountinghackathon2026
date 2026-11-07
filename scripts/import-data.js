import fs from 'node:fs/promises';
import {authenticate,importRows} from '../lib/supabase.js';
import {parseCSV} from '../lib/csv.js';
const [teamId,name='invoices']=process.argv.slice(2);
if(!/^[0-9a-f-]{36}$/i.test(teamId||''))throw Error('Usage: npm run import:data -- TEAM_UUID DATASET_NAME');
const manifest=JSON.parse(await fs.readFile(new URL('../data/manifest.json',import.meta.url),'utf8'));
if(!Object.hasOwn(manifest.tables,name))throw Error('Choose a table from data/manifest.json');
const db=await authenticate(process.env.SUPABASE_ACCESS_TOKEN);
console.log(await importRows(db,teamId,name,parseCSV(await fs.readFile(new URL(`../data/${name}.csv`,import.meta.url),'utf8'))));
