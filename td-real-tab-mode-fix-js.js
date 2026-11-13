(function(){
  function modeClear(){
    document.body.classList.remove('td-index-mode','td-stock-mode','td-mcx-mode','screener-mode');
  }
  function applyBottomModeForSymbol(sym){
    modeClear();
    document.body.classList.remove('market-mode');
    if(isIndexSymbol(sym)) document.body.classList.add('td-index-mode');
    else if(isMCXSymbol(sym)) document.body.classList.add('td-mcx-mode');
    else document.body.classList.add('td-stock-mode');
    fixBottomTabsForCurrentMode();
  }
  function fixBottomTabsForCurrentMode(){
    /* Single tab-visibility owner: delegate to tdSyncTabs (bottom-default-fix script) when present, so two
       interval "fixers" no longer fight over the same buttons. */
    if(typeof window.tdSyncTabs === 'function') return window.tdSyncTabs();
    const tabs=[...document.querySelectorAll('.tb .tbt')];
    const set=(allowed)=>tabs.forEach(b=>{
      const ok=allowed.includes(b.dataset.tab);
      b.style.display=ok?'':'none';
      if(!ok) b.classList.remove('active');
    });
    if(document.body.classList.contains('market-mode') || document.body.classList.contains('crypto-mode')){show('tbar','none');return;}
    show('tbar','flex');
    if(document.body.classList.contains('td-index-mode')) set(['analysis','marketinfo']);
    else if(document.body.classList.contains('td-mcx-mode')) set(['overview','analysis','marketinfo']);
    else if(document.body.classList.contains('td-stock-mode')) set(['overview','analysis','screener','marketinfo']);
  }

  const oldApply = window.applyInstrumentData;
  if(typeof oldApply === 'function'){
    window.applyInstrumentData = function(sym,name,liveData,opts){
      const r = oldApply.apply(this, arguments);
      if(r !== false && sym === CUR_SYM) applyBottomModeForSymbol(sym);
      return r;
    };
  }

  const oldRender = window.renderTab;
  if(typeof oldRender === 'function'){
    window.renderTab = async function(tab){
      if(tab==='strategy'){ANALYSIS_VIEW='strategy';tab='analysis';}
      if(tab==='score'){ANALYSIS_VIEW='decision';tab='analysis';}
      if(tab==='alerts'){tabMarketInfo._view='alerts';tab='marketinfo';}
      const r = await oldRender.call(this, tab);
      fixBottomTabsForCurrentMode();
      const active = document.querySelector(`.tb .tbt[data-tab="${tab}"]`);
      if(active && active.style.display !== 'none'){
        document.querySelectorAll('.tb .tbt').forEach(b=>b.classList.toggle('active', b===active));
      }
      return r;
    };
  }

  function fmtMktItem(item, decimals=2){
    if(!item || item.error || !Number.isFinite(+item.price)) return {v:'--', c:'--', up:null};
    return {
      v:(+item.price).toLocaleString('en-IN',{minimumFractionDigits:decimals,maximumFractionDigits:decimals}),
      c:(item.isUp?'▲ ':'▼ ')+(item.ticker==='^TNX' && Number.isFinite(+item.chg) ? Math.abs(+item.chg*100).toFixed(0)+' bp' : Math.abs(+item.pct||0).toFixed(2)+'%'),
      up:!!item.isUp
    };
  }
  function marketCard(label,item,decimals=2){
    const x=fmtMktItem(item,decimals);
    /* Volatility indices: a rising VIX is risk-off, so colour it red (inverse of price colouring). */
    const inverse = /VIX/i.test(label);
    const col=x.up===null?'#94a3b8':(x.up!==inverse)?'var(--bull)':'var(--bear)';
    return `<div class="td-mtab"><div class="td-mtab-name">${label}</div><div class="td-mtab-val">${x.v}</div><div class="td-mtab-chg" style="color:${col}">${x.c}</div></div>`;
  }
  window.renderCompactMarketDashboardV19 = async function(force=false){
    const tc=document.getElementById('tc');
    if(!tc) return;
    const live = tcBeginRender();
    show('es','none');show('ls','none');show('ih','none');show('tbar','none');show('tc','flex');
    document.body.classList.add('market-mode');
    document.body.classList.remove('crypto-mode','td-index-mode','td-stock-mode','td-mcx-mode');
    const sidebar=document.getElementById('sidebar'); if(sidebar) sidebar.style.display='none';
    tc.innerHTML='<div class="td-market-compact"><div class="ls" style="display:flex;min-height:80px"><div class="sp"></div></div></div>';
    try{ await preloadMarketContext(force); }catch(e){}
    if(!live()) return; /* user opened something else while market data was loading */
    const d=GLOBAL_DATA||{};
    const bias = computeGlobalBiasVerdict ? computeGlobalBiasVerdict(d) : null;
    const biasCol = bias?.cls==='bull'?'var(--bull)':bias?.cls==='bear'?'var(--bear)':'var(--neu)';
    const breadth = d.breadth;
    const iv = d.ivRank;
    const biasCard = `<div class="td-mtab"><div class="td-mtab-name">Global Bias</div><div class="td-mtab-val" style="color:${biasCol}">${bias?.label||'--'}</div><div class="td-mtab-chg" style="color:${biasCol}">Score ${Number.isFinite(bias?.score)?bias.score.toFixed(1):'--'}</div></div>`;
    const breadthCard = `<div class="td-mtab"><div class="td-mtab-name">A/D Ratio</div><div class="td-mtab-val" style="color:${(breadth?.adRatio||0)>1?'var(--bull)':'var(--bear)'}">${breadth?breadth.advances+'↑ '+breadth.declines+'↓':'--'}</div><div class="td-mtab-chg">${breadth?breadth.adRatio+':1':'--'}</div></div>`;
    const ivCard = `<div class="td-mtab"><div class="td-mtab-name">IV Percentile</div><div class="td-mtab-val" style="color:${iv?.rank<30?'var(--bull)':iv?.rank>70?'var(--bear)':'var(--neu)'}">${iv?.rank??'--'}%</div><div class="td-mtab-chg">${iv?.signal==='cheap'?'BUY opts':iv?.signal==='expensive'?'SELL opts':'Fair'}</div></div>`;
    tc.innerHTML = `<div class="td-market-compact">
      <div class="td-market-head"><div class="td-market-title">Global Market Snapshot</div><div class="td-market-time">${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</div></div>
      <div class="td-market-grid">
        ${biasCard}
        ${marketCard('Nasdaq',d.nasdaq,0)}${marketCard('S&P 500',d.sp500,0)}${marketCard('Dow',d.dow,0)}
        ${marketCard('Nikkei',d.nikkei,0)}${marketCard('Hang Seng',d.hangseng,0)}${marketCard('USD/INR',d.usdInr,2)}
        ${marketCard('DXY',d.dxy,2)}${marketCard('US 10Y',d.us10y,2)}${marketCard('WTI',d.wti,2)}
        ${marketCard('Brent',d.brent,2)}${marketCard('India VIX',d.vix,2)}${ivCard}${breadthCard}
      </div>
      <div class="td-market-note">Price alerts: open a stock and tap 🔔 next to the WhatsApp button.</div>
      ${typeof dataPanelHtml === 'function' ? dataPanelHtml() : ''}
    </div>`;
  };

  const oldShowGlobal = window.showGlobalTab;
  if(typeof oldShowGlobal === 'function'){
    window.showGlobalTab = async function(tab){
      if(tab==='marketinfo' && document.body.classList.contains('market-mode') && !tabMarketInfo._view){
        return renderCompactMarketDashboardV19();
      }
      const sidebar=document.getElementById('sidebar'); if(sidebar) sidebar.style.display='none';
      document.body.classList.add('market-mode');
      return oldShowGlobal.apply(this, arguments);
    };
  }


  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('.nbtn').forEach(btn=>{
      btn.addEventListener('click',()=>setTimeout(()=>{
        const v=btn.dataset.view;
        const sidebar=document.getElementById('sidebar');
        if(v!=='markets' && sidebar) sidebar.style.display='';
        if(v==='markets') { /* rendered once by the main nav handler */ }
        else if(v==='indices') { document.body.classList.remove('market-mode','crypto-mode'); modeClear(); document.body.classList.add('td-index-mode'); fixBottomTabsForCurrentMode(); }
        else if(v==='commodities') { document.body.classList.remove('market-mode','crypto-mode'); modeClear(); document.body.classList.add('td-mcx-mode'); fixBottomTabsForCurrentMode(); }
        else if(v==='stocks') { document.body.classList.remove('market-mode','crypto-mode'); modeClear(); document.body.classList.add('td-stock-mode'); fixBottomTabsForCurrentMode(); }
      },80));
    });
  });
})();
