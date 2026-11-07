import {requestJSON} from './sources.js';
// Optional server-side helpers. No production payment or real-bank integration.
export function stripeTestCheckout({priceId,successUrl,cancelUrl,idempotencyKey},{key=process.env.STRIPE_TEST_SECRET_KEY,fetcher=fetch}={}){
 if(!key?.startsWith('sk_test_'))throw Error('Stripe test secret required; live keys are not accepted');
 if(!/^price_[A-Za-z0-9]+$/.test(priceId)||!idempotencyKey)throw Error('Test price ID and idempotency key required');
 for(const value of [successUrl,cancelUrl]){const u=new URL(value);if(!['http:','https:'].includes(u.protocol))throw Error('HTTP(S) return URL required');}
 const body=new URLSearchParams({mode:'payment','line_items[0][price]':priceId,'line_items[0][quantity]':'1',success_url:successUrl,cancel_url:cancelUrl});
 return requestJSON('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idempotencyKey},body},fetcher);
}
export async function plaidSandboxItem({institutionId='ins_109508',products=['transactions']}={}, {clientId=process.env.PLAID_CLIENT_ID,secret=process.env.PLAID_SANDBOX_SECRET,fetcher=fetch}={}){
 if(!clientId||!secret||!/^ins_\d+$/.test(institutionId)||!Array.isArray(products)||!products.length||products.some(p=>!['transactions','auth','identity','assets'].includes(p)))throw Error('Valid Plaid sandbox configuration required');
 const post=(route,payload)=>requestJSON('https://sandbox.plaid.com'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:clientId,secret,...payload})},fetcher);
 const item=await post('/sandbox/public_token/create',{institution_id:institutionId,initial_products:products});
 if(!item.public_token)throw Error('Sandbox response missing public token');
 return post('/item/public_token/exchange',{public_token:item.public_token});
}
