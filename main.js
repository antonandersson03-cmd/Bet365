const Apify = require('apify');
const { chromium } = require('playwright');
Apify.main(async () => {
    const input = await Apify.getInput() || {};
    const startUrl = input.startUrl || 'https://www.bet365.com/#/AC/B1/C1/D8/E183853570/F3/';
    const headless = typeof input.headless === 'boolean' ? input.headless : true;
    const dataset = await Apify.openDataset();
    const browser = await chromium.launch({ headless, args:['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    const captured = [];
    page.on('response', async response => {
        try {
            const url = response.url();
            const ct = (response.headers()['content-type']||'');
            if (ct.includes('application/json') || url.match(/(odds|market|markets|event|bet|price)/i)) {
                const txt = await response.text().catch(()=>null);
                if (!txt) return;
                try { const parsed = JSON.parse(txt); captured.push({url, parsed}); } catch(e) {}
            }
        } catch(e){}
    });
    try { await page.goto(startUrl, { waitUntil:'networkidle', timeout:45000 }); } catch(e){}
    await page.waitForTimeout(2500);
    // Try parse captured JSONs for market-like structures
    function extractMarkets(list) {
        const out = [];
        for (const it of list) {
            const p = it.parsed;
            function traverse(o){
                if (!o || typeof o !== 'object') return;
                if (Array.isArray(o)) { for(const el of o) traverse(el); return; }
                const keys = Object.keys(o).join(' ');
                if (/market|markets|outcomes|selections|runners|prices|odds/i.test(keys)) {
                    // try simple extraction
                    if (Array.isArray(o.outcomes) || Array.isArray(o.selections) || Array.isArray(o.runners)) {
                        const arr = o.outcomes || o.selections || o.runners;
                        const marketName = o.name || o.marketName || 'Market';
                        const outcomes = [];
                        for (const r of arr) {
                            const name = r.name || r.label || r.selection || '';
                            const odds = r.price || r.oddsDecimal || r.decimal || r.odds || null;
                            if (odds !== null) outcomes.push({name: String(name).trim(), odds: Number(odds)});
                        }
                        if (outcomes.length) out.push({market_name: marketName, outcomes});
                    }
                }
                for (const k of Object.keys(o)) traverse(o[k]);
            }
            try { traverse(p); } catch(e){}
        }
        return out;
    }
    const markets = extractMarkets(captured);
    if (markets.length) {
        await dataset.pushData({status:'ok', provider:'Bet365', url: startUrl, scraped_at: new Date().toISOString(), markets});
    } else {
        // fallback: DOM heuristic
        const fallback = await page.evaluate(()=>{
            const out = [];
            const sel = ['.gl-MarketGroup','.gl-Market','.sgl-Market','[data-market]'];
            for (const s of sel) {
                const nodes = Array.from(document.querySelectorAll(s)).slice(0,50);
                for (const n of nodes) {
                    try {
                        const nameEl = n.querySelector('.gl-MarketGroup_Name, .sgl-Market_Name') || n.querySelector('[data-market-name]');
                        const mname = nameEl ? nameEl.innerText.trim() : 'Market';
                        const outcomes = [];
                        const els = n.querySelectorAll('.gl-Participant, .gll-Participant, .sl-Participant, [data-outcome]');
                        for (const o of els) {
                            const txt = (o.innerText||'').trim();
                            const parts = txt.split('\\n').map(s=>s.trim()).filter(Boolean);
                            if (parts.length>=2) {
                                const name = parts[0].slice(0,80);
                                const m = parts.join(' ').match(/([1-9]\\d?[.,]\\d{2})/);
                                const odds = m ? Number(m[0].replace(',','.')) : null;
                                if (odds) outcomes.push({name, odds});
                            }
                        }
                        if (outcomes.length) out.push({market_name: mname, outcomes});
                    } catch(e) {}
                }
                if (out.length) break;
            }
            return out;
        });
        if (fallback && fallback.length) {
            await dataset.pushData({status:'ok', provider:'Bet365', url: startUrl, scraped_at:new Date().toISOString(), source:'dom', markets: fallback});
        } else {
            const html = await page.content();
            await Apify.setValue('snapshot.html', html, {contentType:'text/html'});
            await dataset.pushData({status:'error', provider:'Bet365', url: startUrl, scraped_at:new Date().toISOString(), source:'snapshot'});
        }
    }
    await browser.close();
    console.log('Done');
});
