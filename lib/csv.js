export function parseCSV(text,{maxRows=10000}={}) {
 if(typeof text!=='string'||Buffer.byteLength(text)>5_000_000)throw Error('CSV must be text under 5 MB');
 const matrix=[];let row=[],field='',quoted=false,closed=false;
 text=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
 for(let i=0;i<text.length;i++) {const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)throw Error('Unexpected quote');quoted=true;}
  else if(c===','||c==='\n'){row.push(field);field='';closed=false;if(c==='\n'){matrix.push(row);row=[];}}
  else {if(closed)throw Error('Unexpected text after quoted field');field+=c;}
 }
 if(quoted)throw Error('Unclosed quoted field');if(field||row.length||closed){row.push(field);matrix.push(row);}
 const headers=matrix.shift();if(!headers?.length||headers.some(h=>!h)||new Set(headers).size!==headers.length)throw Error('Missing or repeated headers');
 const nonempty=matrix.filter(r=>r.some(v=>v!==''));if(nonempty.length>maxRows)throw Error('Too many rows');
 return nonempty.map((r,i)=>{if(r.length!==headers.length)throw Error(`Row ${i+2}: wrong number of fields`);return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));});
}
export function toCSV(rows) {
 if(!rows.length)return '';const headers=Object.keys(rows[0]);
 const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
 return [headers,...rows.map(r=>headers.map(h=>r[h]))].map(r=>r.map(quote).join(',')).join('\n')+'\n';
}
