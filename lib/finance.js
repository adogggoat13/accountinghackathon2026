export function minor(value,{signed=false,scale=2}={}) {
 if(!Number.isInteger(scale)||scale<0||scale>6)throw Error('Unsupported precision');
 const text=String(value);if(!(signed?/^-?\d+(\.\d+)?$/:/^\d+(\.\d+)?$/).test(text))throw Error('Invalid money');
 const negative=text.startsWith('-');const [whole,frac='']=text.replace('-','').split('.');if(frac.length>scale)throw Error('Too many decimal places');
 const n=BigInt(whole)*10n**BigInt(scale)+BigInt(frac.padEnd(scale,'0')||'0');return negative?-n:n;
}
export function amount(n,scale=2){n=BigInt(n);const s=n<0n?'-':'';n=n<0n?-n:n;const digits=n.toString().padStart(scale+1,'0');return s+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits);}
export function divideRound(n,d){n=BigInt(n);d=BigInt(d);if(d<=0n)throw Error('Positive denominator required');const s=n<0n?-1n:1n;n=n<0n?-n:n;return s*((n+d/2n)/d);}
export function ratio(n,d){if(BigInt(d)===0n)return null;return Number(BigInt(n)*10000n/BigInt(d))/10000;}
export function variance(actual,budget){const a=minor(actual,{signed:true}),b=minor(budget,{signed:true});return {difference:amount(a-b),fraction:b===0n?null:ratio(a-b,b<0n?-b:b)};}
export function dateDays(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('Use ISO date');const n=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)throw Error('Invalid date');return n/86400000;}
export function aging(due,asOf){const n=dateDays(asOf)-dateDays(due);return n<=0?'current':n<=30?'1-30':n<=60?'31-60':n<=90?'61-90':'90+';}
export function runway({cash,monthlyRevenue,monthlyCost,months=12,revenueGrowthBps=0,costGrowthBps=0}){
 if(!Number.isInteger(months)||months<1||months>120)throw Error('Months must be 1–120');
 for(const x of [revenueGrowthBps,costGrowthBps])if(!Number.isInteger(x)||x< -10000||x>10000)throw Error('Growth out of range');
 let balance=minor(cash),revenue=minor(monthlyRevenue),cost=minor(monthlyCost);const schedule=[];
 for(let month=1;month<=months;month++){const opening=balance;balance+=revenue-cost;schedule.push({month,opening:amount(opening),revenue:amount(revenue),cost:amount(cost),closing:amount(balance)});revenue=divideRound(revenue*BigInt(10000+revenueGrowthBps),10000);cost=divideRound(cost*BigInt(10000+costGrowthBps),10000);}
 return {firstNegativeMonth:schedule.find(r=>minor(r.closing,{signed:true})<0n)?.month??null,schedule,assumptions:'Monthly cash receipts and payments; no financing or working-capital lag. Half-away-from-zero rounding to USD cents.'};
}
export function loanSchedule({principal,annualRateBps,months}){
 if(!Number.isInteger(months)||months<1||months>600||!Number.isInteger(annualRateBps)||annualRateBps<0||annualRateBps>100000)throw Error('Invalid loan terms');
 const p=minor(principal);let balance=p,total=0n;const rows=[];
 // Equal-principal amortization, not a fixed-payment mortgage model.
 for(let m=1;m<=months;m++){const interest=divideRound(balance*BigInt(annualRateBps),120000);const pay=m===months?balance:p/BigInt(months);balance-=pay;total+=interest;rows.push({month:m,principal:amount(pay),interest:amount(interest),payment:amount(pay+interest),balance:amount(balance)});}
 return {method:'Equal principal, monthly interest, no fees',totalInterest:amount(total),rows};
}
export function analyzeInvoices(rows,{asOf='2026-09-30'}={}){
 dateDays(asOf);const seen=new Map();let invoice=0n,paid=0n;const findings=[];
 const required=['record_id','invoice_number','vendor_id','amount_usd','paid_usd','approval_status','due_date','source_document'];
 rows.forEach((r,i)=>{
  for(const k of required)if(r[k]===undefined||r[k]==='')throw Error(`Row ${i+2}: missing ${k}`);
  if(r.currency!=='USD')throw Error(`Row ${i+2}: only USD supported`);
  if(!['approved','pending','rejected'].includes(r.approval_status))throw Error('Invalid approval status');
  const a=minor(r.amount_usd),p=minor(r.paid_usd);invoice+=a;paid+=p;
  const key=r.vendor_id+'|'+r.invoice_number;
  const add=(rule,severity,detail)=>findings.push({record_id:r.record_id,rule,severity,detail,evidence:{file:'invoices.csv',row:i+2,document:r.source_document},method:'deterministic'});
  if(seen.has(key))add('duplicate_invoice','high','Same vendor and invoice number as '+seen.get(key));else seen.set(key,r.record_id);
  if(p>a)add('overpayment','high','Paid exceeds invoice by USD '+amount(p-a));
  if(r.approval_status!=='approved')add('missing_approval','medium','Approval status: '+r.approval_status);
  if(r.po_number==='')add('missing_po','medium','Purchase-order reference absent');
  if(r.receipt_status==='missing')add('missing_receipt','medium','Receipt absent');
  if(p<a&&dateDays(r.due_date)<dateDays(asOf))add('overdue_balance','medium','Open USD '+amount(a-p)+'; aging '+aging(r.due_date,asOf));
 });
 return {currency:'USD',asOf,rows:rows.length,grossInvoiceTotal:amount(invoice),recordedPaidTotal:amount(paid),grossOpenBalance:amount(invoice-paid),note:'Gross totals retain duplicates; not verified liabilities.',findings};
}
export function covenantCheck(r){
 if(r.currency!=='USD')throw Error('USD covenant fixture required');
 const debt=minor(r.debt_usd),ebitda=minor(r.ttm_ebitda_usd,{signed:true}),service=minor(r.ttm_debt_service_usd),cash=minor(r.ttm_available_cashflow_usd,{signed:true});
 const maximum=minor(r.max_leverage),minimum=minor(r.min_dscr);
 return {record_id:r.record_id,leverage:ebitda>0n?ratio(debt,ebitda):null,leverageBreach:ebitda>0n?debt*100n>maximum*ebitda:null,dscr:service>0n?ratio(cash,service):null,dscrBreach:service>0n?cash*100n<minimum*service:null,note:'Null means ratio cannot be evaluated; check agreement definitions.'};
}
export function portfolioSummary(rows){
 let total=0n,fees=0n;const sectors=new Map(),securities=new Map();
 for(const r of rows){if(r.currency!=='USD'||!/^\d+$/.test(String(r.annual_fee_bps)))throw Error('USD holdings and integer fee basis points required');const value=minor(r.market_value_usd),bps=BigInt(r.annual_fee_bps);if(bps>10000n)throw Error('Fee exceeds 100%');total+=value;fees+=divideRound(value*bps,10000n);for(const [m,k]of [[sectors,r.sector],[securities,r.security_id]])m.set(k,(m.get(k)||0n)+value);}
 const aggregate=m=>[...m].map(([name,value])=>({name,value:amount(value),fraction:total?ratio(value,total):null}));
 return {marketValue:amount(total),estimatedAnnualFees:amount(fees),sectors:aggregate(sectors),securities:aggregate(securities),assumption:'Static market values; fees rounded per holding; no returns forecast.'};
}
