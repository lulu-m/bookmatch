/* =========================================================
   SCANNER : vraie caméra de l'iPhone
   - Code-barres : lecture de l'ISBN (fiable) → fiche du livre
   - Couverture : lecture du texte (titre, auteur) sur le téléphone → recherche
   Aucun service payant : ZXing (code-barres, inclus dans l'app) et Tesseract (texte, chargé au besoin).
   ========================================================= */
(()=>{
const SC={stream:null,timer:null,reader:null,busy:false,torch:false};

// ---------- Caméra ----------
async function camStart(){
  if(SC.stream) return true;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ T.scan="nocam"; T.scanErr="Votre navigateur ne donne pas accès à la caméra."; render(); return false; }
  try{
    try{ SC.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}}}); }
    catch(e1){ if(e1&&e1.name==="NotAllowedError") throw e1; SC.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:true}); }
    return true;
  }catch(e){
    // Message précis selon la cause (le code entre parenthèses aide à diagnostiquer)
    const n=e&&e.name||"Erreur";
    T.scanErr=n==="NotAllowedError"?"L'accès à la caméra a été refusé. Autorisez-le dans Réglages › Safari › Caméra (ou Réglages › Apps › Safari › Caméra), puis réessayez.":
      n==="NotReadableError"?"La caméra est déjà utilisée par une autre app. Fermez-la, puis réessayez.":
      n==="NotFoundError"||n==="OverconstrainedError"?"Aucune caméra arrière n'a été trouvée.":"La caméra n'a pas pu s'ouvrir.";
    T.scanErr+=" ("+n+")"; T.scan="nocam";
    render(); return false;
  }
}
function camStop(){
  clearInterval(SC.timer); SC.timer=null;
  if(SC.stream){ SC.stream.getTracks().forEach(t=>t.stop()); SC.stream=null; }
  SC.torch=false;
}
// Après chaque affichage : on rebranche la vidéo (l'écran est redessiné à chaque changement)
function attach(){
  const v=document.getElementById("scanVideo");
  if(!v){ if(SC.stream) camStop(); return; }
  if(SC.stream&&v.srcObject!==SC.stream){ v.srcObject=SC.stream; v.play().catch(()=>{}); }
  if(SC.stream&&T.scanMode==="barcode"&&T.scan==="aim"&&!SC.timer){ SC.aimAt=Date.now(); T.scanSlow=false; SC.timer=setInterval(readBarcode,250); }
  if(T.scan!=="aim"||T.scanMode!=="barcode"){ clearInterval(SC.timer); SC.timer=null; }
}
const _render=window.render; window.render=function(){ const r=_render.apply(this,arguments); try{ attach(); }catch(e){} return r; };

// Image de la caméra → canvas (zone du cadre seulement, pour aller plus vite et mieux lire)
function grab(zoneW,zoneH,scale=1){
  const v=document.getElementById("scanVideo"); if(!v||!v.videoWidth) return null;
  const vw=v.videoWidth, vh=v.videoHeight, w=Math.round(vw*zoneW), h=Math.round(Math.min(vh,w*zoneH));
  const c=document.createElement("canvas"); c.width=Math.round(w*scale); c.height=Math.round(h*scale);
  c.getContext("2d").drawImage(v,(vw-w)/2,(vh-h)/2,w,h,0,0,c.width,c.height);
  return c;
}

// ---------- Code-barres ----------
function readBarcode(){
  if(SC.busy||!window.ZXing) return;
  // Au bout de 8 s sans lecture, un conseil s'affiche
  if(!T.scanSlow&&SC.aimAt&&Date.now()-SC.aimAt>8000){ T.scanSlow=true; render(); }
  // On alterne une zone large et une zone resserrée (petits codes-barres ou livre tenu loin)
  SC.tick=(SC.tick||0)+1; const c=SC.tick%2?grab(.85,.6):grab(.55,.6,1.6); if(!c) return;
  try{
    if(!SC.reader){ SC.reader=new ZXing.MultiFormatReader(); const h=new Map();
      h.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.EAN_8,ZXing.BarcodeFormat.UPC_A]);
      h.set(ZXing.DecodeHintType.TRY_HARDER,true); SC.reader.setHints(h); }
    const bmp=new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(c)));
    const code=SC.reader.decode(bmp).getText();
    if(/^97[89]\d{10}$/.test(code)){ try{navigator.vibrate&&navigator.vibrate(30)}catch(_){} findIsbn(code); }
  }catch(e){ /* pas de code-barres sur cette image : on réessaie au prochain tour */ }
}
async function findIsbn(isbn){
  SC.busy=true; T.scan="busy"; T.scanMsg="Code-barres lu : recherche du livre…"; render();
  try{
    // 1) Déjà dans l'app, ou dans le catalogue BookMatch avec exactement cet ISBN
    let b=BY["isbn-"+isbn]||BOOKS.find(x=>x.isbn===isbn||x.isbn13===isbn);
    if(!b){ const r=await fetch(`${API}/rest/v1/books?select=id,title,author,year,pages,univ,sub,themes,f,cover_url,level,summary&isbn13=eq.${isbn}&limit=1`,{headers:{apikey:ANON}}).then(r=>r.json()).catch(()=>null);
      if(Array.isArray(r)&&r[0]) b=addExt(r[0]); }
    // 2) Sinon, on retrouve le titre et l'auteur de cette édition (BnF, puis Google Books, puis Open Library : gratuits)
    let info=null;
    if(!b) info=await isbnInfo(isbn);
    // 3) Puis on cherche ce titre dans le catalogue : une autre édition du même livre compte
    if(!b&&info){
      const nt=norm(info.title), last=norm(info.author.split(/\s+/).pop()||"");
      const same=x=>x&&(norm(x.title)===nt||norm(x.title).startsWith(nt)||nt.startsWith(norm(x.title)))&&(!last||norm(x.author).includes(last));
      b=BOOKS.find(same);
      if(!b){ const q=info.title+" "+info.author; await new Promise(res=>{ remoteSearch(q,res); setTimeout(res,6000); }); b=remoteIds(q).map(id=>BY[id]).find(same); }
      // 4) Livre absent du catalogue : on l'ajoute quand même avec ce qu'on sait
      if(!b) b=addExt({id:"isbn-"+isbn,title:info.title,author:info.author||"Auteur inconnu",year:info.year||null,pages:info.pages||null,summary:info.summary||"",
        cover_url:info.cover||`https://products-images.di-static.com/image/x/${isbn}-475x500-1.jpg`,univ:[],sub:"",themes:[],f:{}});
    }
    if(b){ T.scanHit=b.id; T.scan="ok"; } else { T.scan="fail"; T.scanErr=`Code lu : ${isbn}. Ce livre n'a été trouvé dans aucun catalogue.`; }
  }catch(e){ T.scan="fail"; T.scanErr=`Code lu : ${isbn}. La recherche n'a pas abouti, vérifiez votre connexion.`; }
  SC.busy=false; render();
}
// Titre, auteur, année d'une édition à partir de son ISBN
async function isbnInfo(isbn){
  const tmo=(p,ms=7000)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(null),ms))]);
  // BnF : toutes les éditions françaises (dépôt légal)
  try{
    const x=await tmo(fetch("https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=dublincore&maximumRecords=1&query="+encodeURIComponent('bib.isbn adj "'+isbn+'"')).then(r=>r.text()));
    if(x){ const d=new DOMParser().parseFromString(x,"text/xml"), g=n=>{ const e=d.getElementsByTagNameNS("*",n)[0]; return e?e.textContent.trim():""; };
      const t=g("title").split(/\s[:\/]\s/)[0].trim();
      const c=g("creator").replace(/\s*\(.*$/,"").replace(/\.\s*Auteur.*$/,"").trim(), [nom,pre]=c.split(/,\s*/);
      if(t) return {title:t,author:pre?pre+" "+nom:nom||"",year:+(g("date").match(/\d{4}/)||[])[0]||null}; }
  }catch(e){}
  // Google Books
  try{
    const r=await tmo(fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:"+isbn).then(r=>r.json()));
    const v=r&&r.items&&r.items[0]&&r.items[0].volumeInfo;
    if(v&&v.title) return {title:v.title,author:(v.authors||[]).join(", "),year:+(v.publishedDate||"").slice(0,4)||null,pages:v.pageCount,summary:v.description,
      cover:v.imageLinks?(v.imageLinks.thumbnail||"").replace("http:","https:").replace("&edge=curl",""):null};
  }catch(e){}
  // Open Library
  try{
    const o=await tmo(fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`).then(r=>r.json())), d=o&&o["ISBN:"+isbn];
    if(d&&d.title) return {title:d.title,author:(d.authors||[]).map(a=>a.name).join(", "),year:+((d.publish_date||"").match(/\d{4}/)||[])[0]||null,pages:d.number_of_pages,cover:d.cover&&(d.cover.large||d.cover.medium)};
  }catch(e){}
  return null;
}

// ---------- Couverture ----------
// Deux méthodes combinées :
//  1) Comparaison visuelle avec les 466 couvertures du catalogue (miniatures déjà dans l'app) : rapide, sans réseau.
//  2) Lecture du texte (Tesseract) : sert à confirmer, et à retrouver les livres hors catalogue local.

// Zone exacte du cadre blanc, en pixels de la vidéo.
// La vidéo est en « object-fit: cover » : elle est agrandie puis rognée pour remplir l'écran, il faut donc convertir.
function frameRect(margin=0){
  const v=document.getElementById("scanVideo"), f=document.querySelector(".scanframe");
  if(!v||!v.videoWidth||!f) return null;
  const vr=v.getBoundingClientRect(), fr=f.getBoundingClientRect();
  const k=Math.max(vr.width/v.videoWidth, vr.height/v.videoHeight);          // pixels écran par pixel vidéo
  const ox=vr.left+(vr.width-v.videoWidth*k)/2, oy=vr.top+(vr.height-v.videoHeight*k)/2;
  const mx=fr.width*margin, my=fr.height*margin;
  let x=(fr.left-mx-ox)/k, y=(fr.top-my-oy)/k, w=(fr.width+2*mx)/k, h=(fr.height+2*my)/k;
  x=Math.max(0,x); y=Math.max(0,y); w=Math.min(v.videoWidth-x,w); h=Math.min(v.videoHeight-y,h);
  return {v,x,y,w,h};
}
// Copie une zone de la vidéo dans un canvas, à la taille voulue (le plus grand côté = maxSide)
function grabRect(r,maxSide){
  const s=maxSide/Math.max(r.w,r.h), c=document.createElement("canvas");
  c.width=Math.round(r.w*s); c.height=Math.round(r.h*s);
  const g=c.getContext("2d"); g.imageSmoothingQuality="high"; g.drawImage(r.v,r.x,r.y,r.w,r.h,0,0,c.width,c.height);
  return c;
}

// ===== 1) Comparaison visuelle =====
// Chaque couverture est réduite à une « empreinte » de 12×18 pixels en couleur, normalisée
// (on retire la luminosité moyenne et on égalise le contraste : une photo sombre ou surexposée reste comparable).
const FP_W=12, FP_H=18;
function fingerprint(src,sx,sy,sw,sh){
  // Réduction en deux étapes pour un résultat lissé (une seule grosse réduction crée du bruit)
  const m=document.createElement("canvas"); m.width=FP_W*4; m.height=FP_H*4;
  const gm=m.getContext("2d"); gm.imageSmoothingQuality="high"; gm.drawImage(src,sx,sy,sw,sh,0,0,m.width,m.height);
  const c=document.createElement("canvas"); c.width=FP_W; c.height=FP_H;
  const g=c.getContext("2d"); g.imageSmoothingQuality="high"; g.drawImage(m,0,0,FP_W,FP_H);
  const d=g.getImageData(0,0,FP_W,FP_H).data, n=FP_W*FP_H, out=new Float32Array(n*3);
  // 3 canaux proches de la perception : luminosité, opposition rouge/vert, opposition jaune/bleu.
  // Beaucoup plus résistant aux reflets et aux photos ternes que le rouge/vert/bleu brut.
  for(let i=0;i<n;i++){ const r=d[i*4],gg=d[i*4+1],b=d[i*4+2]; out[i]=r*.299+gg*.587+b*.114; out[n+i]=r-gg; out[2*n+i]=(r+gg)/2-b; }
  for(let ch=0;ch<3;ch++){
    let s=0,q=0; for(let i=ch*n;i<(ch+1)*n;i++){ s+=out[i]; q+=out[i]*out[i]; }
    const mu=s/n, sd=Math.sqrt(Math.max(q/n-mu*mu,0))+1;
    for(let i=ch*n;i<(ch+1)*n;i++) out[i]=(out[i]-mu)/sd;
  }
  return out;
}
const corr=(a,b)=>{ let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s/a.length; };   // 1 = identique, 0 = sans rapport
let FPS=null;   // empreintes du catalogue, calculées une fois à partir des planches de miniatures
function loadFingerprints(){ return FPS||(FPS=(async()=>{
  if(typeof SPR==="undefined") return [];
  const sheets=await Promise.all(Array.from({length:SPR_N},(_,n)=>new Promise(ok=>{ const im=new Image(); im.onload=()=>ok(im); im.onerror=()=>ok(null); im.src=`sprites/s${n}.jpg`; })));
  const list=[];
  for(const [id,[n,c,r]] of Object.entries(SPR)){ const im=sheets[n]; if(!im||!BY[id]) continue; list.push({id,fp:fingerprint(im,c*150,r*225,150,225)}); }
  return list;
})().catch(()=>{ FPS=null; return []; })); }
// Compare la photo à chaque couverture. La couverture ne remplit jamais parfaitement le cadre :
// on essaie plusieurs tailles et positions de fenêtre, et on garde la meilleure ressemblance.
async function visualMatch(r){
  const list=await loadFingerprints(); if(!list.length) return [];
  const c=grabRect(r,360), W=c.width, H=c.height, wins=[];
  for(const s of [1,.94,.88,.82,.76,.7]) for(const ax of [.62,.68,.74]){            // ax = largeur/hauteur de la couverture
    let h=H*s, w=h*ax; if(w>W*s){ w=W*s; h=w/ax; }
    for(const dx of [-.05,0,.05]) for(const dy of [-.04,0,.04]){
      const x=(W-w)/2+dx*W, y=(H-h)/2+dy*H; if(x<-2||y<-2||x+w>W+2||y+h>H+2) continue;
      wins.push(fingerprint(c,Math.max(0,x),Math.max(0,y),Math.min(w,W),Math.min(h,H)));
    }
  }
  return list.map(({id,fp})=>{ let best=-1; for(const q of wins){ const v=corr(fp,q); if(v>best) best=v; } return {id,v:best}; }).sort((a,b)=>b.v-a.v);
}

// ===== 2) Lecture du texte =====
let tessP=null, workerP=null;
function loadTess(){ return tessP||(tessP=new Promise((ok,ko)=>{ if(window.Tesseract) return ok();
  const s=document.createElement("script"); s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"; s.onload=ok; s.onerror=()=>{tessP=null;ko();}; document.head.appendChild(s); })); }
// Un seul « lecteur » gardé en mémoire : le recréer à chaque photo rechargeait toute la langue (lent sur iPhone)
function getWorker(){ return workerP||(workerP=loadTess().then(()=>Tesseract.createWorker("fra",1)).then(async w=>{
  await w.setParameters({tessedit_pageseg_mode:"11"});   // « texte épars » : adapté aux couvertures (mots dispersés, tailles variées)
  return w; }).catch(e=>{ workerP=null; throw e; })); }
// Prépare l'image pour la lecture : niveaux de gris, contraste étiré ; version inversée pour le texte clair sur fond foncé
function ocrCanvas(src,invert){
  const c=document.createElement("canvas"); c.width=src.width; c.height=src.height;
  const g=c.getContext("2d"); g.drawImage(src,0,0); const im=g.getImageData(0,0,c.width,c.height), d=im.data;
  const hist=new Uint32Array(256), L=new Uint8ClampedArray(d.length/4);
  for(let i=0,j=0;i<d.length;i+=4,j++){ const y=(d[i]*.299+d[i+1]*.587+d[i+2]*.114)|0; L[j]=y; hist[y]++; }
  // On étire le contraste entre les 2 % les plus sombres et les 2 % les plus clairs
  const n=L.length; let lo=0,hi=255,a=0; for(;lo<255&&(a+=hist[lo])<n*.02;lo++); a=0; for(;hi>0&&(a+=hist[hi])<n*.02;hi--);
  const k=255/Math.max(hi-lo,1);
  for(let i=0,j=0;i<d.length;i+=4,j++){ let y=(L[j]-lo)*k; if(invert) y=255-y; d[i]=d[i+1]=d[i+2]=y; }
  g.putImageData(im,0,0); return c;
}
async function readText(r){
  const w=await getWorker(), src=grabRect(r,1600), words=[];
  for(const inv of [false,true]){
    const {data}=await w.recognize(ocrCanvas(src,inv));
    (data.words||[]).forEach(x=>{ const t=x.text.replace(/[^\p{L}\p{N}'’-]/gu,""); if(x.confidence>=35&&t.length>=2&&/\p{L}/u.test(t)) words.push({t,n:norm(t),c:x.confidence,h:x.bbox.y1-x.bbox.y0,y:x.bbox.y0,x:x.bbox.x0}); });
  }
  return words;
}
// Ressemblance entre deux mots (0 à 1), en tolérant les fautes de lecture : « Avlon » ≈ « Avion »
function lev(a,b){ const m=a.length,n=b.length; if(!m||!n) return Math.max(m,n); let p=Array.from({length:n+1},(_,j)=>j);
  for(let i=1;i<=m;i++){ const q=[i]; for(let j=1;j<=n;j++) q[j]=Math.min(p[j]+1,q[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1)); p=q; } return p[n]; }
const STOP=new Set(["les","des","une","dans","pour","sur","aux","est","qui","que","the","and","with","par","son","ses","mon","nos","vos","leur"]);
const keyToks=s=>{ const all=norm(s).replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean), k=all.filter(t=>t.length>=3&&!STOP.has(t)); return k.length?k:all.filter(t=>t.length>=2); };
// Part des mots d'un titre (ou d'un nom d'auteur) retrouvés dans le texte lu
function found(toks,ocr,joined){
  if(!toks.length) return 0; let s=0;
  for(const t of toks){
    if(t.length>=5&&joined.includes(t)){ s+=1; continue; }      // mot collé à un autre par la lecture
    let best=0; for(const o of ocr){ if(Math.abs(o.length-t.length)>2) continue; const v=1-lev(t,o)/Math.max(t.length,o.length); if(v>best) best=v; }
    s+=best>=(t.length<=4?.99:.74)?best:0;                          // mots courts : il faut les lire sans faute
  }
  return s/toks.length;
}
function textScores(words){
  const ocr=[...new Set(words.map(w=>w.n.replace(/[^a-z0-9]/g,"")).filter(x=>x.length>=2))], joined=ocr.join("");
  return BOOKS.filter(b=>!b.future).map(b=>{ const ft=found(keyToks(b.title),ocr,joined), fa=found(keyToks(b.author),ocr,joined); return {id:b.id,ft,fa,s:ft*.65+fa*.35}; })
    .filter(x=>x.ft>=.5||(x.ft>=.3&&x.fa>=.75)).sort((a,b)=>b.s-a.s);
}
// Les mots écrits le plus gros (en général le titre), pour chercher dans tout le catalogue en ligne
function bigWords(words){
  const good=words.filter(w=>w.c>=55&&w.n.length>=3), seen=new Set(); if(!good.length) return "";
  const hmax=Math.max(...good.map(w=>w.h));
  return good.filter(w=>w.h>=hmax*.55).sort((a,b)=>a.y-b.y||a.x-b.x).filter(w=>!seen.has(w.n)&&seen.add(w.n)).slice(0,6).map(w=>w.t).join(" ");
}

async function readCover(){
  const r=frameRect(.04); if(!r){ T.scan="fail"; T.scanErr="La caméra n'est pas prête."; render(); return; }
  SC.busy=true; T.scan="busy"; T.scanAlt=[]; T.scanMsg="Recherche de la couverture…"; render();
  const dbg=window.__scanDbg={};
  try{
    // 1) Comparaison visuelle : si une couverture ressemble nettement plus que toutes les autres, c'est réglé (≈ 0,1 s)
    //    Seuils réglés sur 48 photos tests (inclinées, floues, avec reflets) : 43 bonnes réponses, 3 erreurs sur 48 livres absents.
    const vis=await visualMatch(r); const [v1,v2]=vis, ref=vis[5]?vis[5].v:0;   // ref = 6e meilleure ressemblance (le « bruit de fond »)
    dbg.vis=vis.slice(0,4).map(x=>[x.id,+x.v.toFixed(3)]); if(window.__scanFull) dbg.visAll=vis.map(x=>[x.id,+x.v.toFixed(4)]);
    if(!window.__scanFull&&v1&&v1.v>=.65&&v1.v-v2.v>=.13){ done(v1.id,vis.slice(1,3).filter(x=>x.v-ref>=.15).map(x=>x.id)); return; }
    // 2) Lecture du texte (deux passages : texte foncé, puis texte clair)
    T.scanMsg=workerP?"Lecture du titre…":"Préparation de la lecture (première fois)…"; render();
    const words=await readText(r); if(window.__scanFull) dbg.wordsAll=words;
    dbg.words=words.map(w=>w.t).join(" ").slice(0,200);
    const txt=textScores(words);
    dbg.txt=txt.slice(0,4).map(x=>[x.id,+x.s.toFixed(2)]);
    // 3) On combine : le texte lu et la ressemblance visuelle se renforcent
    const V={}; vis.forEach(x=>V[x.id]=x.v);
    const comb=new Map();
    txt.forEach(x=>comb.set(x.id,x.s+2.5*Math.max(0,(V[x.id]||0)-ref)));
    vis.slice(0,5).forEach(x=>{ if(x.v-ref>=.15&&!comb.has(x.id)) comb.set(x.id,2.5*(x.v-ref)); });
    const ranked=[...comb].sort((a,b)=>b[1]-a[1]);
    dbg.comb=ranked.slice(0,4).map(([id,s])=>[id,+s.toFixed(2)]);
    if(ranked.length&&ranked[0][1]>=.6){ done(ranked[0][0],ranked.slice(1,3).filter(x=>x[1]>=.3).map(x=>x[0])); return; }
    // 4) Livre absent du catalogue local : recherche en ligne avec les mots écrits en gros (le titre, en général)
    const q=bigWords(words); dbg.q=q;
    if(q){ T.scanMsg="Recherche du livre…"; render();
      await new Promise(res=>{ remoteSearch(q,res); setTimeout(res,5000); });
      const ids=remoteIds(q); if(ids.length){ done(ids[0],ids.slice(1,3),true); return; } }
    // 5) Rien de sûr : on montre les candidats les plus proches, en le disant
    const near=[...ranked.map(x=>x[0]),...vis.slice(0,3).map(x=>x.id)].filter((x,i,a)=>a.indexOf(x)===i);
    if(near.length){ done(near[0],near.slice(1,3),true); return; }
    throw 0;
  }catch(e){ T.scan="fail"; T.scanErr="Couverture non reconnue. Cadrez-la en entier, sans reflet, ou utilisez le code-barres au dos (plus fiable)."; }
  SC.busy=false; render();
  function done(id,alt,unsure){ T.scanHit=id; T.scanUnsure=!!unsure; T.scanAlt=(alt||[]).filter(x=>x&&x!==id&&BY[x]); T.scan="ok"; SC.busy=false; try{navigator.vibrate&&navigator.vibrate(30)}catch(_){} render(); }
}

// ---------- Écran ----------
VIEWS.scan=function(){
  const st=T.scan||"aim", mode=T.scanMode||"barcode", b=T.scanHit?BY[T.scanHit]:null;
  const fc=st==="ok"?"var(--accent)":"#FFFFFF";
  const frame=mode==="barcode"?"width:290px;height:170px":"width:230px;height:340px";
  const msg=st==="busy"?(T.scanMsg||"Analyse en cours…"):st==="ok"?(T.scanUnsure?"Livre possible":"Livre trouvé"):mode==="barcode"?(T.scanSlow?"Tenez le livre à 15 cm environ, bien éclairé, code-barres à l'horizontale":"Visez le code-barres au dos du livre"):"Cadrez la couverture, puis touchez le bouton";
  return `<div style="position:absolute;inset:0;background:#000;color:#FFFFFF;display:flex;flex-direction:column;overflow:hidden">
    <video id="scanVideo" playsinline muted autoplay style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
    <div style="position:absolute;inset:0;background:rgba(0,0,0,.35)"></div>
    <div style="position:relative;display:flex;justify-content:space-between;align-items:center;padding:50px 16px 0"><button class="b b-text" data-a="scanClose" style="color:#FFFFFF">Fermer</button><span class="t-head">Scanner</span><button class="iconbtn" data-a="scanTorch" style="color:#FFFFFF" aria-label="Lampe" aria-pressed="${SC.torch}">${ico("flash")}</button></div>
    <p class="t-sub" style="position:relative;text-align:center;margin:24px 20px 16px" role="status">${esc(msg)}</p>
    <div class="scanframe" style="position:relative;${frame};color:${fc}"><span class="c1"></span><span class="c2"></span><span class="c3"></span><span class="c4"></span>
      ${mode==="barcode"&&st==="aim"?`<i style="position:absolute;left:16px;right:16px;top:50%;height:2px;background:rgba(255,255,255,.7);animation:scanline 1.6s ease-in-out infinite alternate"></i>`:""}</div>
    ${st==="nocam"?`<div style="position:relative;margin:24px 24px 0;text-align:center"><p class="t-body">${esc(T.scanErr||"")}</p><button class="b b-primary" data-a="scanRetry" style="margin-top:16px">Réessayer</button></div>`:""}
    ${st==="aim"||st==="busy"||st==="nocam"?`<div style="position:relative;margin-top:auto;padding-bottom:40px;display:flex;flex-direction:column;align-items:center;gap:20px">
      <div class="seg dark" role="tablist" style="width:260px"><button role="tab" aria-selected="${mode==="barcode"}" data-a="scanMode" data-m="barcode">Code-barres</button><button role="tab" aria-selected="${mode==="cover"}" data-a="scanMode" data-m="cover">Couverture</button></div>
      ${st==="busy"?`<div class="spinner" style="border-color:rgba(255,255,255,.2);border-top-color:#FFFFFF;width:40px;height:40px"></div>`:mode==="cover"&&st==="aim"?`<button class="shutter" data-a="shoot" aria-label="Lire la couverture"><i></i></button>`:`<div style="height:8px"></div>`}
      <button class="b b-text" data-a="manual" style="color:#FFFFFF;text-decoration:underline;text-underline-offset:3px">Saisir le titre</button></div>`:""}
    ${st==="ok"&&b?`<div class="sheet sheet-enter" style="color:var(--ink)"><div class="grabber"></div><div class="sheet-body" style="padding-top:16px;display:flex;flex-direction:column;gap:16px">
      ${T.scanUnsure?`<span class="t-foot muted" style="font-weight:600">Pas tout à fait sûr : est-ce l'un de ces livres ?</span>`:`<span class="t-foot" style="color:var(--success);font-weight:600">Livre identifié</span>`}
      <div style="display:grid;grid-template-columns:56px 1fr;gap:16px;align-items:center">${cover(b,56,9.5)}<div><p class="t-book-m">${esc(b.title)}</p><p class="t-sub muted">${esc(b.author)}${b.pages?" · "+b.pages+" p.":""}</p></div></div>
      ${(T.scanAlt||[]).length?`<div style="display:flex;flex-direction:column;gap:8px"><span class="t-foot muted">Ou peut-être :</span>${T.scanAlt.map(id=>BY[id]).filter(Boolean).map(a=>`<button class="row" data-a="scanPick" data-id="${a.id}" style="appearance:none;border:0;background:none;padding:0;display:grid;grid-template-columns:36px 1fr;gap:12px;align-items:center;text-align:left;color:var(--ink);cursor:pointer;min-height:44px">${cover(a,36,6)}<span><span class="t-sub" style="display:block">${esc(a.title)}</span><span class="t-foot muted">${esc(a.author)}</span></span></button>`).join("")}</div>`:""}
      <button class="b b-primary b-block" data-a="confirmScan">C'est bien celui-ci</button>
      <div style="display:flex;justify-content:space-between"><button class="b b-text" data-a="rescan">Rescanner</button><button class="b b-text" data-a="manual">Ce n'est pas lui</button></div></div></div>`:""}
    ${st==="fail"?`<div class="sheet sheet-enter" style="color:var(--ink)"><div class="grabber"></div><div class="sheet-body" style="padding-top:16px;display:flex;flex-direction:column;gap:12px">
      <h2 class="t-title2">Livre non trouvé</h2><p class="t-sub muted">${esc(T.scanErr||"")}</p>
      <button class="b b-primary b-block" data-a="rescan">Réessayer</button><button class="b b-ghost b-block" data-a="manual">Chercher par titre ou ISBN</button></div></div>`:""}
  </div>`;
};

// ---------- Actions ----------
Object.assign(A,{
  async scan(){ T.sheet=null; T.scan="aim"; T.scanHit=null; T.scanMode=T.scanMode||"barcode"; push("scan"); if(await camStart()) render(); },
  async scanRetry(){ T.scan="aim"; render(); if(await camStart()) render(); },
  scanClose(){ camStop(); T.stack.pop(); T.anim=null; render(); },
  scanMode(d){ T.scanMode=d.m; if(T.scan!=="busy") T.scan=SC.stream?"aim":T.scan; render(); if(d.m==="cover"){ loadFingerprints(); getWorker().catch(()=>{}); } },   // on prépare dès le choix du mode : la photo sera analysée plus vite
  shoot(){ if(!SC.busy) readCover(); },
  rescan(){ T.scan="aim"; T.scanHit=null; T.scanAlt=[]; render(); },
  scanPick(d){ const old=T.scanHit; T.scanHit=d.id; T.scanAlt=(T.scanAlt||[]).map(x=>x===d.id?old:x); render(); },   // choisir une autre proposition
  async scanTorch(){ const tr=SC.stream&&SC.stream.getVideoTracks()[0]; const cap=tr&&tr.getCapabilities?tr.getCapabilities():{};
    if(!cap.torch){ toast("Lampe non disponible sur ce téléphone"); return; }
    SC.torch=!SC.torch; try{ await tr.applyConstraints({advanced:[{torch:SC.torch}]}); }catch(e){} render(); },
  manual(){ camStop(); T.stack.pop(); T.addQ=""; T.sheet={v:"add"}; render(); },
  confirmScan(){ const id=T.scanHit; camStop(); T.stack.pop(); if(!id){ render(); return; }
    if(S.lib[id]){ push("fiche",{id}); toast("Déjà dans votre bibliothèque"); return; }
    T.draftStatus="lu"; sheet("confirm",{id,from:"scan"}); },
});
// Si on quitte l'app pendant le scan, on coupe la caméra
document.addEventListener("visibilitychange",()=>{ if(document.hidden) camStop(); else if(document.getElementById("scanVideo")&&T.scan==="aim") camStart().then(ok=>ok&&render()); });
// Animation de la ligne de visée
const st=document.createElement("style"); st.textContent="@keyframes scanline{from{transform:translateY(-55px)}to{transform:translateY(55px)}}"; document.head.appendChild(st);
})();
