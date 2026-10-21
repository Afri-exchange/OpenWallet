import type { Checkout } from "../../sdk/checkout/src/index.ts";
import { PRODUCTS, usd, type PricedLine } from "./catalog.ts";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--ink:#1d1a17;--mute:#6f675f;--bg:#faf6f0;--card:#fff;--line:#e8dfd3;--accent:#8a4b1f;--ok:#1f7a4d;--bad:#b3261e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:20px clamp(16px,4vw,40px);display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line)}
header a{color:inherit;text-decoration:none;font-weight:700;font-size:20px;letter-spacing:-.01em}
header span{color:var(--mute);font-size:14px}
main{max-width:1040px;margin:0 auto;padding:24px clamp(16px,4vw,40px) 64px}
h1{font-size:28px;letter-spacing:-.02em;margin:8px 0 4px}
.sub{color:var(--mute);margin:0 0 24px}
.layout{display:grid;grid-template-columns:1fr 340px;gap:28px;align-items:start}
@media(max-width:820px){.layout{grid-template-columns:1fr}}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:6px}
.emoji{font-size:40px;line-height:1}
.card h3{margin:6px 0 0;font-size:16px}
.card p{margin:0;color:var(--mute);font-size:14px;flex:1}
.price{font-weight:700}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:10px;padding:.65em 1.1em;cursor:pointer;background:var(--ink);color:#fff;text-decoration:none;display:inline-block;text-align:center;min-height:44px;transition:transform .12s,opacity .15s}
button:active,.btn:active{transform:scale(.97)}
button:disabled{opacity:.5;cursor:default;transform:none}
button.ghost,.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
button.add{width:100%}
:focus-visible{outline:3px solid #c9822f;outline-offset:2px}
aside{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;position:sticky;top:16px}
aside h2{margin:0 0 10px;font-size:18px}
.line{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:10px 0;border-top:1px solid var(--line)}
.line .nm{font-weight:600}
.step{display:flex;align-items:center;gap:4px}
.step button{min-height:36px;min-width:36px;padding:0;background:transparent;color:var(--ink);border:1px solid var(--line)}
.step output{min-width:24px;text-align:center}
.total{display:flex;justify-content:space-between;font-weight:700;font-size:18px;padding:14px 0 12px;border-top:1px solid var(--line)}
.empty{color:var(--mute);padding:8px 0 4px}
.err{color:var(--bad);margin:10px 0 0;min-height:1.4em}
.note{color:var(--mute);font-size:13px;margin-top:10px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;max-width:620px}
.status{display:flex;align-items:center;gap:10px;margin:14px 0;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;background:#c9822f;animation:pulse 1.2s ease-in-out infinite}
.dot.ok{background:var(--ok);animation:none}.dot.bad{background:var(--bad);animation:none}
@keyframes pulse{50%{opacity:.3}}
@media(prefers-reduced-motion:reduce){.dot{animation:none}button,.btn{transition:none}}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0}
.mono{font:13px ui-monospace,Menlo,monospace;background:#f3ece1;border-radius:8px;padding:8px 10px;word-break:break-all}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
[hidden]{display:none!important}
#bar{display:none}
@media(max-width:820px){#bar{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));display:flex;justify-content:space-between;align-items:center;background:var(--ink);color:#fff;border-radius:14px;padding:12px 16px;text-decoration:none;font-weight:600;box-shadow:0 6px 24px #0004}main{padding-bottom:96px}}
`;

const shell = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${head}<style>${CSS}</style></head><body>
<header><a href="/">Bean &amp; Brew</a><span>Sample shop for @agent-cards/checkout</span></header><main>${body}</main></body></html>`;

export function shopPage(): string {
  const cards = PRODUCTS.map((p) => `<article class="card"><div class="emoji" aria-hidden="true">${p.emoji}</div>
<h3>${esc(p.name)}</h3><p>${esc(p.blurb)}</p><div class="price">${usd(p.priceCents)}</div>
<button class="add" data-add="${esc(p.id)}">Add to cart</button></article>`).join("");
  const catalog = JSON.stringify(PRODUCTS.map(({ id, name, priceCents }) => ({ id, name, priceCents }))).replace(/</g, "\\u003c");
  return shell("Bean & Brew", `
<h1>Coffee, brewed properly</h1><p class="sub">Add a few things, check out, and pay with an Agent Card.</p>
<div class="layout"><section class="grid" aria-label="Products">${cards}</section>
<a id="bar" href="#cart" hidden><span id="barn">View cart</span><span id="bart"></span></a>
<aside id="cart" aria-label="Your cart"><h2>Your cart</h2><div id="lines"></div>
<div class="total"><span>Total</span><span id="total">$0.00</span></div>
<button id="go" style="width:100%" disabled>Checkout</button>
<p class="err" id="err" role="alert"></p>
<p class="note">You'll get a payment link to give to your agent.</p></aside></div>
<script>
const CATALOG=${catalog};const usd=c=>'$'+(c/100).toFixed(2);
let cart=[];try{cart=JSON.parse(localStorage.getItem('cart')||'[]').filter(l=>CATALOG.some(p=>p.id===l.id))}catch{}
const $=s=>document.querySelector(s);
function save(){localStorage.setItem('cart',JSON.stringify(cart));render()}
function change(id,d){const l=cart.find(x=>x.id===id);if(!l)cart.push({id,qty:1});else{l.qty=Math.min(20,l.qty+d);if(l.qty<1)cart=cart.filter(x=>x!==l)}save()}
function render(){
  const box=$('#lines');let total=0;
  box.innerHTML=cart.length?'':'<p class="empty">Nothing here yet.</p>';
  for(const l of cart){const p=CATALOG.find(x=>x.id===l.id);total+=p.priceCents*l.qty;
    const d=document.createElement('div');d.className='line';
    d.innerHTML='<span class="nm"></span><span></span><span class="step"><button aria-label="Remove one">−</button><output></output><button aria-label="Add one">+</button></span><span style="text-align:right"></span>';
    d.children[0].textContent=p.name;d.children[1].textContent=usd(p.priceCents);
    d.querySelector('output').textContent=l.qty;d.children[3].textContent=usd(p.priceCents*l.qty);
    const [m,a]=d.querySelectorAll('button');m.onclick=()=>change(l.id,-1);a.onclick=()=>change(l.id,1);box.append(d)}
  $('#total').textContent=usd(total);$('#go').disabled=!cart.length;
  const n=cart.reduce((s,l)=>s+l.qty,0);$('#bar').hidden=!n;
  $('#barn').textContent='View cart ('+n+')';$('#bart').textContent=usd(total)}
document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>change(b.dataset.add,1));
$('#go').onclick=async()=>{const b=$('#go'),e=$('#err');e.textContent='';b.disabled=true;b.textContent='Placing order…';
  try{const r=await fetch('/api/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cart})});
    const j=await r.json();if(!r.ok)throw new Error(j.error||'Something went wrong.');
    localStorage.removeItem('cart');location.href='/order/'+j.orderId}
  catch(x){e.textContent=x.message;b.textContent='Checkout';b.disabled=!cart.length}};
render();
</script>`);
}

export function orderPage(o?: { order: { id: string; lines: PricedLine[]; totalCents: number }; checkout: Checkout; head: string; button: string; demoAgent: boolean }): string {
  if (!o) return shell("Order not found", `<div class="panel"><h1>We can't find that order</h1><p class="sub">It may be from before the shop restarted.</p><a class="btn" href="/">Back to the shop</a></div>`);
  const { order, checkout: c } = o;
  const rows = order.lines.map((l) => `<div class="row"><span>${l.qty} × ${esc(l.product.name)}</span><span>${usd(l.product.priceCents * l.qty)}</span></div>`).join("");
  return shell(`Order ${order.id}`, `<div class="panel">
<h1>Pay for your order</h1><p class="sub">Order ${esc(order.id)}</p>${rows}
<div class="row" style="font-weight:700;border-top:1px solid var(--line);margin-top:6px;padding-top:12px"><span>Total</span><span>${usd(order.totalCents)}</span></div>
<div class="status" aria-live="polite"><span class="dot" id="dot"></span><span id="msg">Loading…</span></div>
<div id="pay" ${c.status === "open" ? "" : "hidden"}>
  <p class="note" style="margin-top:0">Give this link to your agent, or let it pay from this page. The agent pays from the wallet you funded, inside your limits.</p>
  <div class="mono" id="link">${esc(c.checkoutUrl)}</div>
  <div class="actions">${o.button}${o.demoAgent ? `<button class="ghost" id="demo">Pay as demo agent</button>` : ""}<button class="ghost" id="copy">Copy link</button><button class="ghost" id="cancel">Cancel order</button></div>
</div>
<div class="actions" id="after" hidden><a class="btn" href="/">Back to the shop</a></div>
<p class="err" id="err" role="alert"></p></div>
<script>
const id=${JSON.stringify(order.id)};const $=s=>document.querySelector(s);
const TEXT={open:['Waiting for your agent to pay…',''],processing:['Payment is going through…',''],
 paid:['Paid. Thank you! Your order is on its way.','ok'],canceled:['This order was canceled.','bad'],expired:['This order expired before it was paid.','bad']};
let timer;
function show(s){let [t,k]=TEXT[s.status]||['Checking…',''];
  if(s.status==='paid'&&!s.fulfilled)t='Paid. Confirming your order…';
  if(s.underReview)t='Your payment is being reviewed. We\\'ll ship once it clears.';
  else if(s.status==='open'&&s.lastAttemptFailed)t='The last payment attempt was declined. Your agent can try again.';
  $('#msg').textContent=t;$('#dot').className='dot '+k;
  const live=s.status==='open'||s.status==='processing';
  $('#pay').hidden=s.status!=='open';$('#after').hidden=live;
  if(!live)clearInterval(timer)}
async function poll(){try{const r=await fetch('/api/orders/'+id);const j=await r.json();if(!r.ok)throw new Error(j.error);show(j);$('#err').textContent=''}
  catch(e){$('#err').textContent='Having trouble checking your payment. Retrying…'}}
async function act(path,btn,label){btn.disabled=true;const was=btn.textContent;btn.textContent=label;$('#err').textContent='';
  try{const r=await fetch('/api/orders/'+id+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json();
    if(!r.ok)throw new Error(j.error||'Something went wrong.');show(j)}
  catch(e){$('#err').textContent=e.message}finally{btn.disabled=false;btn.textContent=was}}
$('#cancel').onclick=e=>act('/cancel',e.currentTarget,'Canceling…');
const d=$('#demo');if(d)d.onclick=e=>act('/demo-pay',e.currentTarget,'Paying…');
$('#copy').onclick=async e=>{try{await navigator.clipboard.writeText($('#link').textContent);e.currentTarget.textContent='Copied'}catch{e.currentTarget.textContent='Select the link above'}};
poll();timer=setInterval(poll,2000);
</script>`, o.head);
}
