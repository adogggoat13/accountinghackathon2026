import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';
import {analyzeInvoices} from '../lib/finance.js';
const result=analyzeInvoices(parseCSV(await fs.readFile(new URL('../data/invoices.csv',import.meta.url),'utf8')));
console.log(JSON.stringify({...result,findings:undefined,findingCount:result.findings.length,rules:result.findings.reduce((a,f)=>(a[f.rule]=(a[f.rule]||0)+1,a),{})},null,2));
