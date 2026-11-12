// CIRCArt — simulate the solo dealer: node src/tools/sim_dealer.js docs/app.js docs/artline.json 20000 fresh
// Prints how often each card is SHOWN (first 11 of a deal) per game, by tier and century.
const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');
const start=src.indexOf('const SEEN_KEY');const end=src.indexOf('let hitsterDeck');
let store={};global.localStorage={getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v}};
eval(src.slice(start,end).replace('class Dealer','global.Dealer=class Dealer'));
const deck=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const N=+process.argv[4], mode=process.argv[5], SHOWN=11;
const shown={}, dealt={}; deck.forEach(c=>{shown[c.id]=0;dealt[c.id]=0});
for(let i=0;i<N;i++){ if(mode==='fresh'||i%5===0) store={};      // 'session': 5 games in a row, then a break > 6 h
  const d=new Dealer(deck).deal(11); const all=[...d.starting_cards,...d.draw_pile];
  all.forEach(c=>dealt[c.id]++); all.slice(0,SHOWN).forEach(c=>shown[c.id]++); }
const by=deck.map(c=>({t:c.title,a:c.artist,y:c.year,tier:c.tier_label,p:shown[c.id]/N*100})).sort((x,y)=>x.p-y.p);
const avg=by.reduce((s,x)=>s+x.p,0)/by.length;
console.log(mode,'avg % of games a card is SHOWN:',avg.toFixed(1));
const grp=k=>{const g={};by.forEach(x=>{const key=k(x);(g[key]=g[key]||[]).push(x.p)});return Object.entries(g).map(([k,v])=>k+': '+(v.reduce((a,b)=>a+b)/v.length).toFixed(1)+'%').join(' | ')};
console.log('by tier:',grp(x=>x.tier));console.log('by century:',grp(x=>x.y<1500?'<1500':x.y<1600?'1500s':x.y<1700?'1600s':x.y<1800?'1700s':x.y<1900?'1800s':'1900+'));
const pick=['Mona Lisa','The Last Supper','David','Self-Portrait at Twenty-Eight','Melencolia I','An Old Man and His Grandson'];
by.filter(x=>pick.includes(x.t)).forEach(x=>console.log(' ',x.p.toFixed(1)+'%',x.tier,x.y,x.a,'-',x.t));
console.log('lowest 8:');by.slice(0,8).forEach(x=>console.log(' ',x.p.toFixed(1)+'%',x.tier,x.y,x.a,'-',x.t));
console.log('highest 8:');by.slice(-8).forEach(x=>console.log(' ',x.p.toFixed(1)+'%',x.tier,x.y,x.a,'-',x.t));
