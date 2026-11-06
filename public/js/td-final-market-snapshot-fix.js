(function(){
  function isMarketsView(){
    return document.body.classList.contains('market-mode') ||
      document.querySelector('.nbtn[data-view="markets"]')?.classList.contains('active') ||
      document.getElementById('view-markets')?.classList.contains('active');
  }
  async function forceMarketSnapshot(){
    if(typeof renderCompactMarketDashboardV19 !== 'function') return;
    if(window.tabMarketInfo) tabMarketInfo._view = null;
    document.body.classList.add('market-mode');
    document.body.classList.remove('crypto-mode','td-index-mode','td-stock-mode','td-mcx-mode');
    const sidebar=document.getElementById('sidebar');
    if(sidebar) sidebar.style.display='none';
    await renderCompactMarketDashboardV19();
  }

  const previousShowGlobalTab = window.showGlobalTab;
  if(typeof previousShowGlobalTab === 'function'){
    window.showGlobalTab = async function(tab){
      if(tab === 'marketinfo' && isMarketsView() && !(window.tabMarketInfo && tabMarketInfo._view)){
        return forceMarketSnapshot();
      }
      return previousShowGlobalTab.apply(this, arguments);
    };
  }

  /* The Markets button is rendered once by the main nav handler; the old triple re-render
     (0/120/450 ms) here raced with sub-tab clicks and was removed. */
})();
