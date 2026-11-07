export async function requestJSON(url,options={},fetcher=fetch){
 const response=await fetcher(url,{...options,signal:options.signal||AbortSignal.timeout(30000)});
 if(!response.ok)throw Error(`Upstream HTTP ${response.status}; retry later if rate limited`);
 return response.json();
}
// Server-only wrappers. No credentials are printed or included in errors.
export function companyFacts(cik,{userAgent=process.env.SEC_USER_AGENT,fetcher=fetch}={}){
 if(!/^\d{1,10}$/.test(String(cik))||!userAgent)throw Error('Provide numeric CIK and identifying SEC_USER_AGENT');
 return requestJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10,'0')}.json`,{headers:{'User-Agent':userAgent}},fetcher);
}
export function fredSeries(series,{key=process.env.FRED_API_KEY,fetcher=fetch}={}){
 if(!/^[A-Za-z0-9_]+$/.test(series)||!key)throw Error('Series and FRED_API_KEY required');
 const url=new URL('https://api.stlouisfed.org/fred/series/observations');url.search=new URLSearchParams({series_id:series,api_key:key,file_type:'json'});
 return requestJSON(url,{},fetcher);
}
export function bankInstitutions(cert,{key=process.env.FDIC_API_KEY,fetcher=fetch}={}){
 if(!/^\d+$/.test(String(cert)))throw Error('Numeric FDIC certificate required');
 const url=new URL('https://api.fdic.gov/banks/institutions');url.search=new URLSearchParams({filters:`CERT:${cert}`,format:'json',limit:'10',...(key?{api_key:key}:{})});return requestJSON(url,{},fetcher);
}
