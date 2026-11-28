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
    window.tdSyncTabs?.();
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
  /* "Live" while the market traded in the last 30 minutes, else "Closed" with the time (or date) of its last
     trade in IST - a last-night close must not look like a live move. */
  function marketStatus(item){
    const at = Number(item && item.at);
    if(!(at > 0)) return '';
    if(Date.now() / 1000 - at < 1800) return '<div class="td-mtab-st live">● Live</div>';
    const d = new Date(at * 1000), ist = x => new Date(x.getTime() + 330 * 60000).toISOString().slice(0, 10);
    const same = ist(d) === ist(new Date());
    const t = d.toLocaleString('en-IN', same ? { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' } : { day:'2-digit', month:'short', timeZone:'Asia/Kolkata' });
    return `<div class="td-mtab-st">Closed · ${t}</div>`;
  }
  function marketCard(label,item,decimals=2){
    const x=fmtMktItem(item,decimals);
    /* Volatility indices: a rising VIX is risk-off, so colour it red (inverse of price colouring). */
    const inverse = /VIX/i.test(label);
    const col=x.up===null?'#94a3b8':(x.up!==inverse)?'var(--bull)':'var(--bear)';
    return `<div class="td-mtab"><div class="td-mtab-name">${label}</div><div class="td-mtab-val">${x.v}</div><div class="td-mtab-chg" style="color:${col}">${x.c}</div>${marketStatus(item)}</div>`;
  }
  window.renderCompactMarketDashboardV19 = async function(force=false){
    const tc=document.getElementById('tc');
    if(!tc) return;
    const live = tcBeginRender();
    show('es','none');show('ls','none');show('ih','none');show('tbar','none');show('tc','flex');
    document.body.classList.add('market-mode');
    document.body.classList.remove('td-index-mode','td-stock-mode','td-mcx-mode');
    const sidebar=document.getElementById('sidebar'); if(sidebar) sidebar.style.display='none';
    tc.innerHTML='<div class="td-market-compact"><div class="ls" style="display:flex;min-height:80px"><div class="sp"></div></div></div>';
    try{ await preloadMarketContext(force); }catch(e){}
    if(!live()) return; /* user opened something else while market data was loading */
    const d=GLOBAL_DATA||{};
    const bias = computeGlobalBiasVerdict ? computeGlobalBiasVerdict(d) : null;
    const biasCol = bias?.cls==='bull'?'var(--bull)':bias?.cls==='bear'?'var(--bear)':'var(--neu)';
    const breadth = d.breadth;
    const iv = d.ivRank;
    /* FII / DII (22 Nov 2026): last session's cash-market net, Rs Cr; the reason when no source answered */
    const fd = d.fiiDii?.days?.[0], fsg = v => v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('en-IN')}`;
    const fiiCard = `<div class="td-mtab" title="${fd ? 'Net buying, Rs Cr (cash market) - ' + escHtml(d.fiiDii.source || '') : escHtml(d.fiiDiiError || 'not loaded yet')}"><div class="td-mtab-name">FII/DII${fd ? ' ' + new Date(fd.date + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short'}) : ''}</div>`
      + (fd ? `<div class="td-mtab-val" style="color:${fd.fii >= 0 ? 'var(--bull)' : 'var(--bear)'}">FII ${fsg(fd.fii)}</div><div class="td-mtab-chg" style="color:${fd.dii == null ? 'var(--tx3)' : fd.dii >= 0 ? 'var(--bull)' : 'var(--bear)'}">DII ${fsg(fd.dii)}</div>`
        : `<div class="td-mtab-val" style="color:var(--tx3)">--</div><div class="td-mtab-chg" style="color:var(--tx3)">${d.fiiDiiError ? 'source unreachable' : 'loading'}</div>`) + `</div>`;
    const biasCard = `<div class="td-mtab"><div class="td-mtab-name">Global Bias</div><div class="td-mtab-val" style="color:${biasCol}">${bias?.label||'--'}</div><div class="td-mtab-chg" style="color:${biasCol}">Score ${Number.isFinite(bias?.score)?bias.score.toFixed(1):'--'}</div></div>`;
    const breadthCard = `<div class="td-mtab"><div class="td-mtab-name">A/D Ratio</div><div class="td-mtab-val">${breadth?`<span style="color:var(--bull)">${breadth.advances}↑</span> <span style="color:var(--bear)">${breadth.declines}↓</span>`:'--'}</div><div class="td-mtab-chg" style="color:${!breadth?'var(--tx3)':breadth.adRatio>1?'var(--bull)':breadth.adRatio<1?'var(--bear)':'var(--neu)'}">${breadth?breadth.adRatio+':1':'--'}</div></div>`;
    const ivCard = `<div class="td-mtab"><div class="td-mtab-name">IV Percentile</div><div class="td-mtab-val" style="color:${iv?.rank<30?'var(--bull)':iv?.rank>70?'var(--bear)':'var(--neu)'}">${iv?.rank??'--'}%</div><div class="td-mtab-chg">${iv?.signal==='cheap'?'BUY opts':iv?.signal==='expensive'?'SELL opts':'Fair'}</div></div>`;
    tc.innerHTML = `<div class="td-market-compact">
      <div class="td-market-head"><div class="td-market-title">Global Market Snapshot</div><div class="td-market-time">${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</div></div>
      <div class="td-market-sec">India</div>
      <div class="td-market-grid">
        ${marketCard('GIFT Nifty',d.giftNifty,0)}${biasCard}${marketCard('India VIX',d.vix,2)}${ivCard}${breadthCard}${fiiCard}
      </div>
      <div class="td-market-sec">US cash close · Asia · Europe</div>
      <div class="td-market-grid">
        ${marketCard('S&P 500',d.sp500,0)}${marketCard('Nasdaq',d.nasdaq,0)}${marketCard('Dow',d.dow,0)}${marketCard('US VIX',d.usvix,2)}
        ${marketCard('Nikkei',d.nikkei,0)}${marketCard('Hang Seng',d.hangseng,0)}${marketCard('DAX',d.dax,0)}${marketCard('FTSE 100',d.ftse,0)}
      </div>
      <div class="td-market-sec">Gold &amp; silver (COMEX, $) · currency · rates</div>
      <div class="td-market-grid">
        ${marketCard('Gold $',d.gold,1)}${marketCard('Silver $',d.silver,2)}
        ${marketCard('USD/INR',d.usdInr,2)}${marketCard('DXY',d.dxy,2)}${marketCard('US 10Y',d.us10y,2)}
      </div>
      <div class="td-market-sec">Oil</div>
      <div class="td-market-grid">
        ${marketCard('WTI',d.wti,2)}${marketCard('Brent',d.brent,2)}
      </div>
      <div class="td-market-note">Price alerts: open a stock and tap 🔔 next to the WhatsApp button.</div>
      ${typeof dataPanelHtml === 'function' ? dataPanelHtml() : ''}
      ${typeof deployNoteHtml === 'function' ? deployNoteHtml() : ''}
    </div>`;
  };

  /* Leaving the Markets page brings the stock / index / MCX list back (the mode itself is set by td-bottom-default-fix-js.js). */
  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('.nbtn').forEach(btn=>{
      btn.addEventListener('click',()=>setTimeout(()=>{
        const sidebar=document.getElementById('sidebar');
        if(btn.dataset.view!=='markets' && sidebar) sidebar.style.display='';
      },80));
    });
  });
})();
