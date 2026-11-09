(function(){
  function q(s){return document.querySelector(s)}
  function qa(s){return Array.from(document.querySelectorAll(s))}
  function setMode(mode){
    document.body.classList.remove('td-index-mode','td-stock-mode','td-mcx-mode','crypto-mode','market-mode','screener-mode');
    document.body.classList.add(mode);
  }
  function allowedTabs(){
    if(document.body.classList.contains('market-mode') || document.body.classList.contains('crypto-mode') || document.body.classList.contains('screener-mode')) return [];
    /* No Screener tab here: the sidebar "Open Screener" button opens it. */
    if(document.body.classList.contains('td-stock-mode')) return ['overview','analysis','marketinfo'];
    if(document.body.classList.contains('td-mcx-mode')) return ['overview','analysis','marketinfo'];
    return ['analysis','marketinfo'];
  }
  function hardFixTabs(){
    const bar=q('#tbar'); if(!bar) return;
    const mBtn=q('#tbar .tbt[data-tab="marketinfo"]');
    if(mBtn){
      const lbl = document.body.classList.contains('td-mcx-mode') ? 'News'
        : document.body.classList.contains('td-index-mode') ? 'News & Sectors' : 'News & Sector';
      if(mBtn.textContent !== lbl) mBtn.textContent = lbl;
    }
    const allowed=allowedTabs();
    const es=q('#es'), emptyShown = es && getComputedStyle(es).display !== 'none';
    if(!allowed.length || emptyShown){bar.style.setProperty('display','none','important'); return;}
    bar.style.setProperty('display','flex','important');
    qa('#tbar .tbt').forEach(btn=>{
      const ok=allowed.includes(btn.dataset.tab);
      btn.style.setProperty('display', ok?'inline-flex':'none', 'important');
      if(!ok) btn.classList.remove('active');
    });
    /* Never invent an active tab: Screener/global pages intentionally have none, and a fake "Overview
       active" made auto-refresh think the user was on Overview. */
  }
  window.tdSyncTabs = hardFixTabs;
  function modeFromTopButton(btn){
    const v=btn && btn.dataset ? btn.dataset.view : '';
    if(v==='stocks') return 'td-stock-mode';
    if(v==='commodities') return 'td-mcx-mode';
    if(v==='crypto') return 'crypto-mode';
    if(v==='markets') return 'market-mode';
    if(v==='screener') return 'screener-mode';
    return 'td-index-mode';
  }
  /* On phones the tab bar is position:fixed at the bottom, but it sat inside <main>, the page's scrolling box.
     In the installed home-screen app (standalone mode) a fixed bar inside a scrolling box can scroll away or be
     clipped by it, so the menu "hid". On phone widths it now lives directly under <body>; on desktop it goes back
     above the content, where it is a normal top tab row. */
  function placeBar(){
    const bar=q('#tbar'), ap=q('.ap'), tc=q('#tc'); if(!bar||!ap) return;
    const phone=window.matchMedia('(max-width:820px)').matches;
    if(phone && bar.parentElement!==document.body) document.body.appendChild(bar);
    else if(!phone && bar.parentElement!==ap) ap.insertBefore(bar, tc && tc.parentElement===ap ? tc : null);
  }
  function init(){
    placeBar();
    try { window.matchMedia('(max-width:820px)').addEventListener('change', placeBar); } catch(e) {}
    if(!document.body.classList.contains('td-stock-mode') && !document.body.classList.contains('td-mcx-mode') && !document.body.classList.contains('crypto-mode') && !document.body.classList.contains('market-mode')){
      document.body.classList.add('td-index-mode');
    }
    qa('.nbtn').forEach(btn=>btn.addEventListener('click',()=>setTimeout(()=>{setMode(modeFromTopButton(btn)); hardFixTabs();},0),true));
    hardFixTabs();
    setTimeout(hardFixTabs,100);
    setTimeout(hardFixTabs,500);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
  window.addEventListener('load',()=>setTimeout(hardFixTabs,50));
  setInterval(hardFixTabs,5000); /* slow safety net only; mode changes call it directly */
})();
