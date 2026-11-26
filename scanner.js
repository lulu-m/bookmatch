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
  if(SC.stream&&T.scanMode==="barcode"&&T.scan==="aim"&&!SC.timer) SC.timer=setInterval(readBarcode,250);
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
  const c=grab(.85,.6); if(!c) return;
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
    // 1) Déjà dans l'app ?
    let b=BY["isbn-"+isbn]||BOOKS.find(x=>x.isbn===isbn);
    // 2) Catalogue BookMatch, par ISBN exact
    if(!b){ const r=await fetch(`${API}/rest/v1/books?select=id,title,author,year,pages,univ,sub,themes,f,cover_url,level,summary&isbn13=eq.${isbn}&limit=1`,{headers:{apikey:ANON}}).then(r=>r.json()).catch(()=>null);
      if(Array.isArray(r)&&r[0]) b=addExt(r[0]); }
    // 3) Recherche du catalogue complet
    if(!b){ await new Promise(res=>{ remoteSearch(isbn,res); setTimeout(res,6000); }); const ids=remoteIds(isbn); b=ids.length?BY[ids[0]]:null; }
    // 4) Google Books puis Open Library (gratuits, sans clé), puis recherche du titre dans le catalogue
    if(!b){ const r=await fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:"+isbn).then(r=>r.json()).catch(()=>null);
      let vi=r&&r.items&&r.items[0]&&r.items[0].volumeInfo;
      if(!vi){ const o=await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`).then(r=>r.json()).catch(()=>null), d=o&&o["ISBN:"+isbn];
        if(d) vi={title:d.title,authors:(d.authors||[]).map(a=>a.name),publishedDate:(d.publish_date||"").match(/\d{4}/)?.[0],pageCount:d.number_of_pages,imageLinks:d.cover?{thumbnail:d.cover.large||d.cover.medium}:null}; }
      if(vi){ const q=vi.title+" "+((vi.authors||[])[0]||"");
        await new Promise(res=>{ remoteSearch(q,res); setTimeout(res,6000); });
        const hit=remoteIds(q).map(id=>BY[id]).find(x=>x&&norm(x.title).includes(norm(vi.title).slice(0,12)));
        b=hit||addExt({id:"isbn-"+isbn,title:vi.title,author:(vi.authors||[]).join(", ")||"Auteur inconnu",year:vi.publishedDate?+vi.publishedDate.slice(0,4):null,pages:vi.pageCount||null,
          summary:vi.description||"",cover_url:vi.imageLinks?(vi.imageLinks.thumbnail||"").replace("http:","https:").replace("&edge=curl",""):null}); } }
    if(b){ T.scanHit=b.id; T.scan="ok"; } else { T.scan="fail"; T.scanErr="Ce code-barres n'est pas dans notre catalogue."; }
  }catch(e){ T.scan="fail"; T.scanErr="La recherche n'a pas abouti. Vérifiez votre connexion."; }
  SC.busy=false; render();
}

// ---------- Couverture (lecture du texte) ----------
let tessP=null;
function loadTess(){ return tessP||(tessP=new Promise((ok,ko)=>{ if(window.Tesseract) return ok();
  const s=document.createElement("script"); s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"; s.onload=ok; s.onerror=()=>{tessP=null;ko();}; document.head.appendChild(s); })); }
async function readCover(){
  const c=grab(.7,1.5,1); if(!c){ T.scan="fail"; T.scanErr="La caméra n'est pas prête."; render(); return; }
  SC.busy=true; T.scan="busy"; T.scanMsg=window.Tesseract?"Lecture de la couverture…":"Préparation de la lecture (première fois)…"; render();
  try{
    await loadTess(); T.scanMsg="Lecture de la couverture…"; render();
    const {data}=await Tesseract.recognize(c,"fra+eng");
    // On garde les mots lus avec assez de certitude
    const words=(data.words||[]).filter(w=>w.confidence>55&&/[a-zà-ÿ]{2,}/i.test(w.text)).map(w=>w.text.replace(/[^\p{L}\p{N}'’-]/gu,"")).filter(Boolean);
    const text=norm(words.join(" "));
    if(text.length<3) throw 0;
    // 1) Livres de l'app dont le titre (et si possible l'auteur) apparaissent sur la couverture
    const toks=t=>norm(t).split(/\s+/).filter(x=>x.length>2);
    const hits=BOOKS.filter(b=>!b.future).map(b=>{ const tt=toks(b.title), at=toks(b.author);
      const ft=tt.length?tt.filter(x=>text.includes(x)).length/tt.length:0, fa=at.length?at.filter(x=>text.includes(x)).length/at.length:0;
      return {b,s:ft*.7+fa*.3,ft}; }).filter(x=>x.ft>=.6).sort((a,b)=>b.s-a.s);
    let b=hits.length?hits[0].b:null;
    // 2) Sinon : recherche dans tout le catalogue avec les mots lus
    if(!b){ const q=words.slice(0,8).join(" ");
      await new Promise(res=>{ remoteSearch(q,res); setTimeout(res,6000); }); const ids=remoteIds(q); b=ids.length?BY[ids[0]]:null; }
    if(b){ T.scanHit=b.id; T.scan="ok"; } else throw 0;
  }catch(e){ T.scan="fail"; T.scanErr="Le titre n'a pas pu être lu. Le code-barres au dos est plus fiable."; }
  SC.busy=false; render();
}

// ---------- Écran ----------
VIEWS.scan=function(){
  const st=T.scan||"aim", mode=T.scanMode||"barcode", b=T.scanHit?BY[T.scanHit]:null;
  const fc=st==="ok"?"var(--accent)":"#FFFFFF";
  const frame=mode==="barcode"?"width:290px;height:170px":"width:230px;height:340px";
  const msg=st==="busy"?(T.scanMsg||"Analyse en cours…"):st==="ok"?"Livre trouvé":mode==="barcode"?"Visez le code-barres au dos du livre":"Cadrez la couverture, puis touchez le bouton";
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
      <span class="t-foot" style="color:var(--success);font-weight:600">Livre identifié</span>
      <div style="display:grid;grid-template-columns:56px 1fr;gap:16px;align-items:center">${cover(b,56,9.5)}<div><p class="t-book-m">${esc(b.title)}</p><p class="t-sub muted">${esc(b.author)}${b.pages?" · "+b.pages+" p.":""}</p></div></div>
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
  scanMode(d){ T.scanMode=d.m; if(T.scan!=="busy") T.scan=SC.stream?"aim":T.scan; render(); if(d.m==="cover") loadTess().catch(()=>{}); },
  shoot(){ if(!SC.busy) readCover(); },
  rescan(){ T.scan="aim"; T.scanHit=null; render(); },
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
