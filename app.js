// ── State ──
let collection = [];
let currentScan = null;

// ── Init ──
window.addEventListener('load', () => {
  loadCollection();
  const gk = localStorage.getItem('pv_gk');
  if (gk) {
    showApp();
  } else {
    show('setup-screen');
    hide('app-screen');
  }
});

// ── Key Management ──
function saveKeys() {
  const gk = document.getElementById('gemini-key').value.trim();
  if (!gk) return alert('Please enter your Gemini API key.');
  localStorage.setItem('pv_gk', gk);
  showApp();
}

function saveSettingsKeys() {
  const gk = document.getElementById('settings-gemini').value.trim();
  if (gk) localStorage.setItem('pv_gk', gk);
  hideSettings();
  toast('Key saved');
}

function showApp() {
  hide('setup-screen');
  show('app-screen');
  renderCollection();
}

// ── Image Handling ──
function handleImage(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    const mimeType = file.type || 'image/jpeg';

    hide('upload-zone');
    document.getElementById('preview-img').src = dataUrl;
    show('preview-area');

    currentScan = null;
    hide('scan-result');
    hide('scan-error');
    show('scan-status');
    document.getElementById('scan-status-text').textContent = 'Identifying card with AI...';

    try {
      const identified = await identifyCardGemini(base64, mimeType);
      currentScan = { ...identified, imageBase64: dataUrl };

      document.getElementById('scan-status-text').textContent = 'Looking up price...';
      const priceData = await lookupPriceTCGdex(identified.name, identified.setId, identified.number);
      currentScan = { ...currentScan, ...priceData };

      hide('scan-status');
      showResult(currentScan);
    } catch (err) {
      hide('scan-status');
      document.getElementById('scan-error-text').textContent = err.message || 'Could not identify card. Try better lighting.';
      show('scan-error');
      console.error(err);
    }
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

// ── Gemini Card Identification ──
async function identifyCardGemini(base64, mimeType) {
  const gk = localStorage.getItem('pv_gk');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${gk}`;

  const prompt = `You are a Pokémon TCG expert. Examine this card image carefully.
Return ONLY a valid JSON object, no markdown, no extra text:
{
  "name": "exact English card name (translate if Japanese)",
  "nameJP": "Japanese name if applicable, otherwise null",
  "set": "full set name in English (e.g. Scarlet & Violet, Paldea Evolved, 151, Ancient Roar, etc.)",
  "setId": "short set code if visible (e.g. sv1, sv2, sv3, etc.) or null",
  "number": "card number as printed (e.g. 025/165) or null",
  "rarity": "rarity (Common, Uncommon, Rare, Rare Holo, Ultra Rare, Secret Rare, etc.)",
  "language": "English or Japanese",
  "type": "Pokemon type or Trainer or Energy"
}
If this is NOT a Pokémon card, return: {"error": "Not a Pokemon card"}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Gemini API error ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('Could not parse AI response. Please try again.');
  }

  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.name) throw new Error('Card name not detected. Try a clearer photo.');

  return parsed;
}

// ── Pokemon TCG Price Lookup (pokemontcg.io — no API key needed) ──
async function lookupPriceTCGdex(name, setId, number) {
  try {
    // Build queries from most specific to least, stop at first match
    const queries = [];
    if (setId && number) {
      const n = number.split('/')[0].replace(/^0+(\d)/, '$1');
      queries.push(`name:"${name}" set.id:${setId.toLowerCase()} number:${n}`);
    }
    if (setId) queries.push(`name:"${name}" set.id:${setId.toLowerCase()}`);
    queries.push(`name:"${name}"`);

    for (const query of queries) {
      const card = await ptcgFetch(query);
      if (card) return extractCardPrice(card);
    }

    return { price: null, pricelow: null, tcgImage: null, setName: null };
  } catch (err) {
    console.warn('Price lookup failed:', err);
    return { price: null, pricelow: null, tcgImage: null, setName: null };
  }
}

async function ptcgFetch(query) {
  const res = await fetch(
    `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=5`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Pokemon TCG API error ${res.status}`);
  const data = await res.json();
  return data.data?.[0] ?? null;
}

function extractCardPrice(card) {
  let price = null;
  let pricelow = null;

  const prices = card.tcgplayer?.prices;
  if (prices) {
    const t = prices.holofoil ?? prices.reverseHolofoil ?? prices.normal ??
      prices['1stEditionHolofoil'] ?? prices['1stEditionNormal'];
    if (t) {
      price = t.market ?? t.mid ?? null;
      pricelow = t.low ?? null;
    }
  }

  if (price == null && card.cardmarket?.prices) {
    const cm = card.cardmarket.prices;
    price = cm.averageSellPrice ?? cm.trendPrice ?? null;
    pricelow = cm.lowPrice ?? null;
  }

  return {
    price,
    pricelow,
    tcgImage: card.images?.large || card.images?.small || null,
    setName: card.set?.name || null,
    tcgdexId: card.id
  };
}

// ── Show Result ──
function showResult(card) {
  document.getElementById('result-name').textContent = card.name;
  const metaParts = [card.setName || card.set, card.number, card.rarity, card.language].filter(Boolean);
  document.getElementById('result-meta').textContent = metaParts.join(' · ');

  document.getElementById('result-price').textContent =
    card.price != null ? `$${Number(card.price).toFixed(2)}` : 'Price unavailable';

  const lowRow = document.getElementById('price-row-low');
  if (card.pricelow != null) {
    document.getElementById('result-price-low').textContent = `$${Number(card.pricelow).toFixed(2)}`;
    lowRow.style.display = 'flex';
  } else {
    lowRow.style.display = 'none';
  }

  show('scan-result');
}

// ── Add to Collection ──
function addToCollection() {
  if (!currentScan) return;

  const entry = {
    id: Date.now(),
    name: currentScan.name,
    nameJP: currentScan.nameJP || null,
    set: currentScan.setName || currentScan.set || '',
    number: currentScan.number || '',
    rarity: currentScan.rarity || '',
    language: currentScan.language || 'English',
    type: currentScan.type || '',
    price: currentScan.price != null ? Number(currentScan.price) : null,
    pricelow: currentScan.pricelow != null ? Number(currentScan.pricelow) : null,
    tcgImage: currentScan.tcgImage || null,
    imageBase64: currentScan.imageBase64 || null,
    addedAt: new Date().toISOString()
  };

  collection.unshift(entry);
  saveCollection();
  updatePortfolioTotal();
  toast(`${entry.name} added!`);
  clearScan();
  switchTab('collection', document.getElementById('tab-btn-collection'));
}

// ── Render Collection ──
function renderCollection() {
  const grid = document.getElementById('card-grid');
  grid.innerHTML = '';

  if (collection.length === 0) {
    show('empty-state');
    updatePortfolioTotal();
    return;
  }

  hide('empty-state');
  updatePortfolioTotal();

  collection.forEach(card => {
    const el = document.createElement('div');
    el.className = 'portfolio-card';
    el.onclick = () => showDetail(card.id);

    const imgSrc = card.tcgImage || card.imageBase64 || null;
    const imgHtml = imgSrc
      ? `<img class="portfolio-card-img" src="${imgSrc}" alt="${card.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const placeholder = `<div class="portfolio-card-img-placeholder" ${imgSrc ? 'style="display:none"' : ''}>🃏</div>`;

    el.innerHTML = `
      ${imgHtml}
      ${placeholder}
      <div class="portfolio-card-info">
        <div class="portfolio-card-name">${card.name}</div>
        <div class="portfolio-card-set">${card.set || '—'} ${card.language === 'Japanese' ? '🇯🇵' : ''}</div>
        <div class="portfolio-card-price">${card.price != null ? '$' + Number(card.price).toFixed(2) : '—'}</div>
      </div>
    `;
    grid.appendChild(el);
  });
}

function updatePortfolioTotal() {
  const total = collection.reduce((sum, c) => sum + (c.price || 0), 0);
  document.getElementById('portfolio-total').textContent = `$${total.toFixed(2)}`;
  document.getElementById('card-count').textContent =
    `${collection.length} card${collection.length !== 1 ? 's' : ''} in collection`;
}

// ── Card Detail ──
function showDetail(id) {
  const card = collection.find(c => c.id === id);
  if (!card) return;

  document.getElementById('detail-name').textContent = card.name;

  const imgSrc = card.tcgImage || card.imageBase64 || null;
  const imgHtml = imgSrc
    ? `<img class="detail-img" src="${imgSrc}" alt="${card.name}" onerror="this.style.display='none'">`
    : `<div class="detail-img-placeholder">🃏</div>`;

  document.getElementById('detail-body').innerHTML = `
    ${imgHtml}
    ${card.nameJP ? `<p class="detail-jp">${card.nameJP}</p>` : ''}
    <div class="detail-grid">
      <div class="detail-stat">
        <div class="detail-stat-label">Market Price</div>
        <div class="detail-stat-val gold">${card.price != null ? '$' + Number(card.price).toFixed(2) : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Low Price</div>
        <div class="detail-stat-val">${card.pricelow != null ? '$' + Number(card.pricelow).toFixed(2) : '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Set</div>
        <div class="detail-stat-val">${card.set || '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Number</div>
        <div class="detail-stat-val">${card.number || '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Rarity</div>
        <div class="detail-stat-val">${card.rarity || '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Language</div>
        <div class="detail-stat-val">${card.language || '—'}</div>
      </div>
    </div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:14px">Added ${new Date(card.addedAt).toLocaleDateString()}</p>
    <button class="btn-danger" onclick="removeCard(${card.id})">Remove from Portfolio</button>
  `;

  show('detail-modal');
}

function hideDetail() { hide('detail-modal'); }

function removeCard(id) {
  if (!confirm('Remove this card?')) return;
  collection = collection.filter(c => c.id !== id);
  saveCollection();
  hideDetail();
  renderCollection();
  toast('Card removed');
}

// ── Settings ──
function showSettings() {
  document.getElementById('settings-gemini').value = localStorage.getItem('pv_gk') || '';
  show('settings-modal');
}

function hideSettings() { hide('settings-modal'); }

function clearAllData() {
  if (!confirm('Delete all cards and settings?')) return;
  localStorage.clear();
  collection = [];
  location.reload();
}

// ── Tabs ──
function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.getElementById(`tab-${name}`).classList.remove('hidden');
  if (name === 'collection') renderCollection();
}

// ── Scan Helpers ──
function clearScan() {
  currentScan = null;
  document.getElementById('preview-img').src = '';
  document.getElementById('file-input').value = '';
  hide('preview-area');
  hide('scan-status');
  hide('scan-result');
  hide('scan-error');
  show('upload-zone');
}

// ── Storage ──
function saveCollection() {
  // Don't save base64 images to keep storage light — use tcgImage (URL) instead
  const toSave = collection.map(c => ({ ...c, imageBase64: null }));
  try {
    localStorage.setItem('pv_collection', JSON.stringify(toSave));
  } catch {
    toast('Storage full — try removing some cards');
  }
}

function loadCollection() {
  try {
    const raw = localStorage.getItem('pv_collection');
    collection = raw ? JSON.parse(raw) : [];
  } catch { collection = []; }
}

// ── UI Helpers ──
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function toggleVis(id) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function modalBackdropClose(event, modalId) {
  if (event.target.id === modalId) hide(modalId);
}

function toast(msg) {
  let el = document.getElementById('toast-el');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-el';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
