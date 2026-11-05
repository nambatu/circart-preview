// State
let artworks = [];
let timeline = [];
let currentCard = null;
let currentRound = 1;
let maxRounds = 10;
let score = 0;
let bonusPoints = 0;
let fetchLoopRunning = false;
let selectedMuseum = 'hitster';
let targetCount = 11;
let loadingTextInterval = null;

const loadingTexts = [
    "Waking up the museum guards...",
    "Telling Picasso to draw a straight line...",
    "Dusting off the Renaissance...",
    "Searching for Bob Ross's happy little trees...",
    "Convincing Mona Lisa to smile...",
    "Gluing the Venus de Milo's arms back on... wait.",
    "Mixing fresh paint...",
    "Looking for Van Gogh's ear...",
    "Searching the Louvre's basement...",
    "Translating ancient Egyptian hieroglyphs...",
    "Teaching Michelangelo how to paint ceilings...",
    "Waiting for Dalí's clocks to melt...",
    "Trying to figure out modern art...",
    "Asking Rembrandt to use a little more light...",
    "Telling Warhol his 15 minutes are up..."
];

// --- Analytics ---------------------------------------------------------------
// Anonymous, cookieless event counting via GoatCounter. No cookies, no personal
// data, nothing that needs a consent banner. Every call is guarded: if the
// script is blocked, absent, or still loading, the game carries on untouched.

function track(name) {
    try {
        if (window.goatcounter && typeof window.goatcounter.count === 'function') {
            window.goatcounter.count({ path: name, title: name, event: true });
        }
    } catch (e) {
        // Analytics must never break gameplay.
    }
}

// DOM Elements
const screens = {
    start: document.getElementById('start-screen'),
    game: document.getElementById('game-screen'),
    end: document.getElementById('end-screen'),
};
const overlay = document.getElementById('loading-overlay');
const timelineEl = document.getElementById('timeline');
const feedbackArea = document.getElementById('feedback-area');
const feedbackMessage = document.getElementById('feedback-message');
const bonusFeedback = document.getElementById('bonus-feedback');
const activeCardSection = document.getElementById('active-card-section');
const activeCardEl = document.getElementById('active-card');
// Events
document.getElementById('start-btn').addEventListener('click', initGame);
document.getElementById('next-round-btn').addEventListener('click', prepareNextRound);
document.getElementById('restart-btn').addEventListener('click', () => {
    screens.end.classList.remove('active');
    screens.start.classList.add('active');
});

async function fetchArtworksLoop() {
    if (fetchLoopRunning) return;
    fetchLoopRunning = true;
    
    try {
        await fetchHitsterArtworks();
    } catch (e) {
        console.error('API Error:', e);
        alert(e.message || 'Error loading artworks. Please try again.');
        overlay.classList.add('hidden');
    } finally {
        fetchLoopRunning = false;
    }
}

// --- Short-term memory of recently dealt cards -------------------------------
// Cards you were shown in the last SEEN_TTL_MS are skipped, so a long sitting
// keeps serving fresh artworks; come back tomorrow and the deck feels new.
// Every localStorage access is guarded: private browsing and blocked
// third-party storage must never stop a round from starting.

const SEEN_KEY = 'seenCards';
const SEEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function readSeen() {
    let raw = null;
    try {
        raw = localStorage.getItem(SEEN_KEY);
    } catch (e) {
        return {};
    }
    if (!raw) return {};

    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return {};
    }

    // Older builds stored a plain array of ids with no timestamps. Drop it.
    if (!data || Array.isArray(data) || typeof data !== 'object') return {};

    const cutoff = Date.now() - SEEN_TTL_MS;
    const fresh = {};
    for (const id in data) {
        if (typeof data[id] === 'number' && data[id] > cutoff) {
            fresh[id] = data[id];
        }
    }
    return fresh;
}

function writeSeen(ids) {
    const seen = readSeen();
    const now = Date.now();
    for (const id of ids) seen[id] = now;
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch (e) {
        // Storage unavailable. The game plays fine without the memory.
    }
}

class Dealer {
    constructor(cards) {
        this.allCards = cards.filter(c => c.image_local || c.image);
        this.TIER_ORDER = ["obscure", "recognisable", "icon"];
    }

    loadFreshCards() {
        const seen = readSeen();

        let fresh = this.allCards.filter(c => !seen[c.id]);
        if (fresh.length > this.allCards.length / 3) {
            return fresh;
        }
        return this.allCards;
    }

    shuffle(array) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex !== 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    startingCards(cards, n) {
        const bands = [[1300, 1600], [1600, 1800], [1800, 1900], [1900, 1960], [1960, 2030]];
        const pool = {};
        for (const [lo, hi] of bands) {
            pool[`${lo}-${hi}`] = [];
        }
        for (const c of cards) {
            for (const [lo, hi] of bands) {
                if (c.year >= lo && c.year < hi && c.tier <= 2) {
                    pool[`${lo}-${hi}`].push(c);
                }
            }
        }
        
        let picked = [];
        let order = this.shuffle([...bands]);
        for (let i = 0; i < n; i++) {
            let band = order[i % order.length];
            let key = `${band[0]}-${band[1]}`;
            let candidates = pool[key].filter(c => !picked.includes(c));
            if (candidates.length === 0) {
                candidates = cards.filter(c => !picked.includes(c));
            }
            picked.push(candidates[Math.floor(Math.random() * candidates.length)]);
        }
        return picked;
    }

    tierForRound(k, total) {
        let t = (k - 1) / Math.max(total - 1, 1);
        return {
            "obscure": 0.45 - 0.45 * t,
            "recognisable": 0.45,
            "icon": 0.10 + 0.45 * t
        };
    }

    buildPile(cards, size, excludeIds) {
        const byTier = { "obscure": [], "recognisable": [], "icon": [] };
        for (const c of cards) {
            if (!excludeIds.includes(c.id)) {
                if (byTier[c.tier_label]) {
                    byTier[c.tier_label].push(c);
                }
            }
        }
        for (const t of this.TIER_ORDER) {
            this.shuffle(byTier[t]);
        }

        let pile = [];
        let recentArtists = [];
        let recentDecades = [];
        const artistGap = 8;
        const decadeGap = 4;

        for (let i = 0; i < size; i++) {
            let w = this.tierForRound(i + 1, size);
            
            let tiers = [...this.TIER_ORDER].sort((a, b) => {
                return (w[b] * Math.random()) - (w[a] * Math.random());
            });

            let chosen = null;
            for (let t of tiers) {
                for (let c of byTier[t]) {
                    if (recentArtists.includes(c.artist)) continue;
                    if (recentDecades.includes(Math.floor(c.year / 10))) continue;
                    chosen = c;
                    break;
                }
                if (chosen) {
                    byTier[t] = byTier[t].filter(x => x !== chosen);
                    break;
                }
            }

            if (!chosen) {
                let flat = [];
                for (let t of this.TIER_ORDER) {
                    flat.push(...byTier[t]);
                }
                if (flat.length === 0) break;
                chosen = flat[Math.floor(Math.random() * flat.length)];
                byTier[chosen.tier_label] = byTier[chosen.tier_label].filter(x => x !== chosen);
            }

            pile.push(chosen);
            recentArtists.push(chosen.artist);
            if (recentArtists.length > artistGap) recentArtists.shift();
            
            recentDecades.push(Math.floor(chosen.year / 10));
            if (recentDecades.length > decadeGap) recentDecades.shift();
        }
        return pile;
    }

    deal(targetRounds) {
        let cards = this.loadFreshCards();
        let starts = this.startingCards(cards, 1);
        let size = Math.min(Math.floor(1 * targetRounds * 2.2), cards.length - 1);
        let pile = this.buildPile(cards, size, starts.map(c => c.id));
        
        let used = [...starts, ...pile].map(c => c.id);
        writeSeen(used);

        return {
            starting_cards: starts,
            draw_pile: pile
        };
    }
}

let hitsterDeck = null;

async function fetchHitsterArtworks() {
    try {
        if (!hitsterDeck) {
            const res = await fetch('artline.json', { cache: 'no-cache' });
            hitsterDeck = await res.json();
        }

        const dealer = new Dealer(hitsterDeck);
        const dealData = dealer.deal(targetCount);
        
        const formatCard = item => ({
            id: item.id,
            primaryImageSmall: item.image_local ? item.image_local.replace(/\\\\/g, '/') : item.image,
            title: item.title,
            artistDisplayName: item.artist,
            objectEndDate: item.year,
            trivia: item.trivia || "Source: WikiArt",
            tier: item.tier,
            movement: item.movement,
            medium: item.medium,
            location: item.location
        });
        
        const pile = dealData.draw_pile.map(formatCard).reverse();
        const startCard = formatCard(dealData.starting_cards[0]);
        
        artworks.push(...pile, startCard);
    } catch(e) {
        console.error("Failed to load dealer game:", e);
        await fetchCMAArtworks();
    }
}

async function fetchMetArtworks() {
    const activeFilters = Array.from(document.querySelectorAll('.filter-btn.active')).map(b => b.dataset.filter);
    const isHighlight = activeFilters.includes('highlight');
    
    let url = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true`;
    if (isHighlight) url += `&isHighlight=true`;
    
    const activeCatBtns = Array.from(document.querySelectorAll('.cat-btn.active')).map(b => b.dataset.metCategory).filter(c => c);
    const allSpecificCats = Array.from(document.querySelectorAll('.cat-btn[data-category]:not([data-category="random"])')).map(b => b.dataset.metCategory).filter(c => c);
    const isRandomActive = document.querySelector('.cat-btn[data-category="random"]').classList.contains('active');
    
    let targetMetCats = [];
    if (isRandomActive) {
        targetMetCats = allSpecificCats[Math.floor(Math.random() * allSpecificCats.length)].split('|');
    } else if (activeCatBtns.length > 0) {
        targetMetCats = [...new Set(activeCatBtns.flatMap(c => c.split('|')))];
    }
    
    const activeTypeBtn = document.querySelector('.type-btn.active');
    const targetType = activeTypeBtn ? activeTypeBtn.dataset.type : 'all';
    
    let q = '*';
    if (targetType === 'Painting') q = 'Painting';
    else if (targetType === 'Sculpture') q = 'Sculpture';
    url += `&q=${q}`;
    
    let allIds = [];
    let totalFound = 0;
    
    if (targetMetCats.length > 0) {
        for (let cat of targetMetCats) {
            try {
                const res = await fetch(url + `&departmentId=${cat}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.objectIDs) {
                        allIds = allIds.concat(data.objectIDs);
                        totalFound += data.total;
                    }
                }
            } catch (e) {
                console.error(`Met API Error for department ${cat}:`, e);
            }
        }
    } else {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                if (data.objectIDs) {
                    allIds = data.objectIDs;
                    totalFound = data.total;
                }
            }
        } catch (e) {
            console.error('Met API Error for all departments:', e);
        }
    }
    
    if (allIds.length < targetCount) {
        throw new Error(`Not enough artworks match these filters. Only ${totalFound} found, but we need enough for a ${document.getElementById('rounds-select').value}-round game.`);
    }
    const addedIds = new Set();
    let consecutiveFailedFetches = 0;
    
    while (artworks.length < targetCount && fetchLoopRunning) {
        const randomIdx = Math.floor(Math.random() * allIds.length);
        const objId = allIds[randomIdx];
        
        if (addedIds.has(objId)) continue;
        
        const objRes = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${objId}`);
        if (!objRes.ok) {
            consecutiveFailedFetches++;
            if (consecutiveFailedFetches > 10) throw new Error(`Could not fetch enough valid artworks for a ${document.getElementById('rounds-select').value}-round game. Please relax your filters.`);
            continue;
        }
        
        const objData = await objRes.json();
        
        if (!objData.primaryImageSmall || objData.objectEndDate === undefined || objData.objectEndDate === null) {
            consecutiveFailedFetches++;
            continue;
        }
        
        let artistName = objData.artistDisplayName || 'Unknown Artist';
        let trivia = '';
        if (objData.medium) trivia += `Medium: ${objData.medium}. `;
        if (objData.creditLine) trivia += `Credit: ${objData.creditLine}. `;
        if (objData.repository) trivia += `${objData.repository}. `;
        
        artworks.push({
            id: objData.objectID,
            primaryImageSmall: objData.primaryImageSmall,
            title: objData.title,
            artistDisplayName: artistName,
            objectEndDate: objData.objectEndDate,
            trivia: trivia.trim()
        });
        
        addedIds.add(objId);
        consecutiveFailedFetches = 0;
        
        await new Promise(r => setTimeout(r, 200));
    }
}

async function fetchCMAArtworks() {
    const activeCatBtns = Array.from(document.querySelectorAll('.cat-btn.active')).map(b => b.dataset.category).filter(c => c);
    const allSpecificCats = Array.from(document.querySelectorAll('.cat-btn[data-category]:not([data-category="random"])')).map(b => b.dataset.category).filter(c => c);
    const isRandomActive = document.querySelector('.cat-btn[data-category="random"]').classList.contains('active');
    
    let targetDepartments = [];
    if (isRandomActive) {
        targetDepartments = allSpecificCats[Math.floor(Math.random() * allSpecificCats.length)].split('|');
    } else if (activeCatBtns.length > 0) {
        targetDepartments = [...new Set(activeCatBtns.flatMap(c => c.split('|')))];
    }
    
    const activeTypeBtn = document.querySelector('.type-btn.active');
    const targetType = activeTypeBtn ? activeTypeBtn.dataset.type : 'all';
    
    const activeFilters = Array.from(document.querySelectorAll('.filter-btn.active')).map(b => b.dataset.filter);

    let baseUrl = `https://openaccess-api.clevelandart.org/api/artworks/?has_image=1`;
    if (targetType !== 'all') baseUrl += `&type=${encodeURIComponent(targetType)}`;
    activeFilters.forEach(filter => {
        baseUrl += `&${filter}=1`;
    });
    
    let catInfos = [];
    let totalAvailable = 0;
    
    if (targetDepartments.length > 0) {
        for (let cat of targetDepartments) {
            let catUrl = baseUrl + `&department=${encodeURIComponent(cat)}&limit=1`;
            try {
                const res = await fetch(catUrl);
                const data = await res.json();
                console.log(`CMA Check for ${cat}:`, data.info);
                if (data.info && data.info.total > 0) {
                    catInfos.push({
                        category: cat,
                        maxOffset: Math.max(0, Math.min(30000, data.info.total - 100))
                    });
                    totalAvailable += data.info.total;
                }
            } catch(e) {
                console.error(`CMA Check Error for ${cat}:`, e);
            }
        }
    } else {
        try {
            const res = await fetch(baseUrl + `&limit=1`);
            const data = await res.json();
            if (data.info && data.info.total !== undefined) {
                catInfos.push({
                    category: '',
                    maxOffset: Math.max(0, Math.min(30000, data.info.total - 100))
                });
                totalAvailable += data.info.total;
            }
        } catch(e) {}
    }
    
    if (totalAvailable < targetCount || catInfos.length === 0) {
        throw new Error(`Not enough artworks match these filters. Only ${totalAvailable} found, but we need enough for a ${document.getElementById('rounds-select').value}-round game.`);
    }
    
    let minGap = 0;
    let attemptsInCurrentGap = 0;
    let consecutiveFailedFetches = 0;
    const addedIds = new Set();
    
    while (artworks.length < targetCount && fetchLoopRunning) {
        const pickedCatInfo = catInfos[Math.floor(Math.random() * catInfos.length)];
        const skip = Math.floor(Math.random() * (pickedCatInfo.maxOffset + 1));
        let url = baseUrl + `&limit=100&skip=${skip}`;
        if (pickedCatInfo.category) url += `&department=${encodeURIComponent(pickedCatInfo.category)}`;
        
        const res = await fetch(url);
        
        if (!res.ok) {
            consecutiveFailedFetches++;
            if (consecutiveFailedFetches > 10) throw new Error('Could not fetch enough matching artworks. Please relax your filters.');
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        
        const data = await res.json();
        const objects = data.data;
        if (!objects || objects.length === 0) {
            consecutiveFailedFetches++;
            if (maxOffset > 0) {
                maxOffset = Math.floor(maxOffset / 2);
            }
            if (consecutiveFailedFetches > 10) throw new Error('Could not fetch enough matching artworks. Please relax your filters.');
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        
        objects.sort(() => Math.random() - 0.5);
        let addedAny = false;
        
        for (const item of objects) {
            if (artworks.length >= targetCount) break;
            if (addedIds.has(item.id)) continue;
            
            const yearEarly = item.creation_date_earliest;
            const yearLate = item.creation_date_latest;
            if (yearEarly === null || yearLate === null || isNaN(yearEarly) || isNaN(yearLate)) continue;
            
            const year = Math.floor((yearEarly + yearLate) / 2);
            const hasEnoughGap = artworks.every(selected => Math.abs(selected.objectEndDate - year) >= minGap);
            
            if (hasEnoughGap && item.images && item.images.web && item.images.web.url) {
                let artistName = 'Unknown Artist';
                if (item.creators && item.creators.length > 0 && item.creators[0].description) {
                    artistName = item.creators[0].description.split('(')[0].trim();
                }
                
                let trivia = '';
                if (item.technique) trivia += `Technique: ${item.technique}. `;
                if (item.culture && item.culture.length > 0) trivia += `Culture: ${item.culture.join(', ')}. `;
                
                let didYouKnow = item.did_you_know ? item.did_you_know.trim() : '';

                artworks.push({
                    id: item.id,
                    primaryImageSmall: item.images.web.url,
                    title: item.title,
                    artistDisplayName: artistName,
                    objectEndDate: year,
                    trivia: trivia.trim(),
                    didYouKnow: didYouKnow
                });
                addedIds.add(item.id);
                addedAny = true;
                attemptsInCurrentGap = 0;
            } else {
                attemptsInCurrentGap++;
            }
        }
        
        if (!addedAny) {
            consecutiveFailedFetches++;
            if (consecutiveFailedFetches > 15) throw new Error(`Struggling to find enough valid artworks for a ${document.getElementById('rounds-select').value}-round game. Please relax your filters.`);
        } else {
            consecutiveFailedFetches = 0;
        }
        
        if (attemptsInCurrentGap > 50 && minGap > 0) {
            minGap = Math.max(0, minGap - 5);
            attemptsInCurrentGap = 0;
        }
        
        await new Promise(res => setTimeout(res, 200));
    }
}

async function fetchEuropeanaArtworks() {
    const activeEuroCatBtns = Array.from(document.querySelectorAll('.cat-btn-eu.active')).map(b => b.dataset.euroCategory).filter(c => c);
    const allSpecificEuroCats = Array.from(document.querySelectorAll('.cat-btn-eu[data-euro-category]:not([data-euro-category="random"])')).map(b => b.dataset.euroCategory).filter(c => c);
    const isRandomActive = document.querySelector('.cat-btn-eu[data-euro-category="random"]').classList.contains('active');
    
    let targetEuroCats = [];
    if (isRandomActive) {
        targetEuroCats = [allSpecificEuroCats[Math.floor(Math.random() * allSpecificEuroCats.length)]];
    } else if (activeEuroCatBtns.length > 0) {
        targetEuroCats = activeEuroCatBtns;
    }
    
    let url = `https://api.europeana.eu/record/v2/search.json?wskey=${europeanaApiKey}&query=*&qf=TYPE:IMAGE&rows=100`;
    
    if (targetEuroCats.length > 0) {
        const joined = targetEuroCats.map(cat => `(${cat})`).join(' OR ');
        url += `&qf=what:(${encodeURIComponent(joined)})`;
    }
    
    const activeTypeBtn = document.querySelector('.type-btn.active');
    const targetType = activeTypeBtn ? activeTypeBtn.dataset.type : 'all';
    
    if (targetType === 'Painting') {
        url += `&qf=what:painting`;
    } else if (targetType === 'Sculpture') {
        url += `&qf=what:sculpture`;
    }
    
    let totalFound = 0;
    try {
        const checkRes = await fetch(url + '&start=1&rows=1');
        const checkData = await checkRes.json();
        if (checkData.success && checkData.totalResults) {
            totalFound = checkData.totalResults;
        }
    } catch (e) {
        console.error("Europeana check error", e);
    }
    
    if (totalFound < targetCount) {
        throw new Error(`Not enough artworks match these filters in Europeana. Found ${totalFound}.`);
    }
    
    let minGap = 0;
    let attemptsInCurrentGap = 0;
    let consecutiveFailedFetches = 0;
    const addedIds = new Set();
    
    while (artworks.length < targetCount && fetchLoopRunning) {
        const start = Math.floor(Math.random() * Math.min(1000, totalFound - 100)) + 1;
        
        const res = await fetch(url + `&start=${start}`);
        if (!res.ok) {
            consecutiveFailedFetches++;
            if (consecutiveFailedFetches > 10) throw new Error('Could not fetch enough matching artworks from Europeana.');
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        
        const data = await res.json();
        const items = data.items;
        if (!items || items.length === 0) {
            consecutiveFailedFetches++;
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        
        items.sort(() => Math.random() - 0.5);
        let addedAny = false;
        
        for (const item of items) {
            if (artworks.length >= targetCount) break;
            if (addedIds.has(item.id)) continue;
            
            if (!item.edmPreview) continue;
            
            let dateStrs = [];
            if (item.dcDate) dateStrs = dateStrs.concat(item.dcDate);
            if (item.edmTimespanLabel) {
                dateStrs = dateStrs.concat(item.edmTimespanLabel.map(o => o.def));
            }
            if (item.year) dateStrs = dateStrs.concat(item.year);
            
            if (dateStrs.length === 0) continue;
            
            // Try to extract year
            let year = null;
            for (const dateStr of dateStrs) {
                const match = String(dateStr).match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
                if (match) {
                    year = parseInt(match[1]);
                    break;
                }
            }
            if (!year) continue;
            
            const hasEnoughGap = artworks.every(selected => Math.abs(selected.objectEndDate - year) >= minGap);
            
            if (hasEnoughGap) {
                const imgUrl = Array.isArray(item.edmPreview) ? item.edmPreview[0] : item.edmPreview;
                let title = (item.title && item.title.length > 0) ? item.title[0] : 'Unknown Title';
                let artistName = 'Unknown Artist';
                if (item.dcCreator && item.dcCreator.length > 0) {
                    artistName = item.dcCreator[0];
                } else if (item.dcContributor && item.dcContributor.length > 0) {
                    artistName = item.dcContributor[0];
                }
                
                let trivia = '';
                if (item.dataProvider) trivia += `Provider: ${item.dataProvider[0]}. `;
                if (item.country) trivia += `Country: ${item.country[0]}. `;
                
                artworks.push({
                    id: item.id,
                    primaryImageSmall: imgUrl,
                    title: title,
                    artistDisplayName: artistName,
                    objectEndDate: year,
                    trivia: trivia.trim(),
                    didYouKnow: ''
                });
                addedIds.add(item.id);
                addedAny = true;
                attemptsInCurrentGap = 0;
            } else {
                attemptsInCurrentGap++;
            }
        }
        
        if (!addedAny) {
            consecutiveFailedFetches++;
            if (consecutiveFailedFetches > 15) throw new Error('Struggling to find valid artworks from Europeana.');
        } else {
            consecutiveFailedFetches = 0;
        }
        
        if (attemptsInCurrentGap > 50 && minGap > 0) {
            minGap = Math.max(0, minGap - 5);
            attemptsInCurrentGap = 0;
        }
        
        await new Promise(r => setTimeout(r, 200));
    }
}

function startLoadingText() {
    const textEl = document.getElementById('loading-text');
    let idx = 0;
    textEl.textContent = loadingTexts[idx];
    loadingTextInterval = setInterval(() => {
        idx = (idx + 1) % loadingTexts.length;
        textEl.textContent = loadingTexts[idx];
    }, 5000);
}

function stopLoadingText() {
    if (loadingTextInterval) {
        clearInterval(loadingTextInterval);
        loadingTextInterval = null;
    }
}

async function initGame() {
    if (selectedMuseum === 'europeana' && !europeanaApiKey) {
        alert("Please enter a Europeana API key.");
        return;
    }
    
    maxRounds = parseInt(document.getElementById('rounds-select').value);
    targetCount = maxRounds + 1;

    track('game-start');
    track('rounds-' + maxRounds);
    document.getElementById('total-rounds').textContent = maxRounds;
    currentRound = 1;
    score = 0;
    bonusPoints = 0;
    timeline = [];
    artworks = [];
    fetchLoopRunning = false;
    
    updateScoreUI();
    
    overlay.classList.remove('hidden');
    startLoadingText();
    
    // Start background loop
    fetchArtworksLoop();
    
    // Wait until at least 2 artworks are loaded
    while (artworks.length < 2) {
        if (!fetchLoopRunning && artworks.length < 2) {
            stopLoadingText();
            // Alert is already handled by fetchArtworksLoop's catch block
            return;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    
    stopLoadingText();
    overlay.classList.add('hidden');
    
    // Startkarte in den Zeitstrahl
    timeline.push(artworks.pop());
    
    screens.start.classList.remove('active');
    screens.game.classList.add('active');
    
    await prepareNextRound();
}

async function prepareNextRound() {
    if (currentRound > maxRounds) {
        endGame();
        return;
    }
    
    document.getElementById('current-round').textContent = currentRound;
    feedbackArea.classList.add('hidden');
    document.getElementById('bonus-section').classList.remove('hidden');
    
    // Reset inputs
    document.getElementById('guess-artist').value = '';
    document.getElementById('guess-title').value = '';
    document.getElementById('guess-year').value = '';
    
    // Nächste Karte ziehen
    document.getElementById('active-title').textContent = "Loading next masterpiece...";
    document.getElementById('active-artist').textContent = "";
    document.getElementById('active-year').textContent = "";
    document.getElementById('active-image').src = "";
    
    while (artworks.length === 0) {
        if (!fetchLoopRunning) {
            alert("No more artworks in the deck! The game is over.");
            endGame();
            return;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    
    currentCard = artworks.pop();
    
    // Karte anzeigen
    document.getElementById('active-image').src = currentCard.primaryImageSmall;
    document.getElementById('active-title').textContent = currentCard.title || 'Unknown';
    
    // Clean up artist string
    const cleanArtist = currentCard.artistDisplayName ? currentCard.artistDisplayName.trim() : 'Unknown Artist';
    currentCard.cleanArtist = cleanArtist;
    document.getElementById('active-artist').textContent = cleanArtist;
    document.getElementById('active-year').textContent = currentCard.objectEndDate;
    
    document.getElementById('active-movement').textContent = currentCard.movement || 'Unknown';
    document.getElementById('active-medium').textContent = currentCard.medium || 'Unknown';
    document.getElementById('active-location').textContent = currentCard.location || 'Unknown';
    
    document.getElementById('active-details').classList.add('hidden');
    activeCardEl.classList.remove('hidden');
    
    renderTimeline();
}

// --- First-run coaching -----------------------------------------------------
// Testers repeatedly missed that the gaps between cards are where you place
// the artwork. Until someone has placed their first card ever, the slots are
// labelled and gently pulsed; afterwards they go quiet.

const PLACED_KEY = 'hasPlacedCard';

function hasPlacedBefore() {
    try {
        return localStorage.getItem(PLACED_KEY) === '1';
    } catch (e) {
        return false;               // storage blocked: coach them, it is harmless
    }
}

function markPlaced() {
    try {
        localStorage.setItem(PLACED_KEY, '1');
    } catch (e) { /* nothing to do */ }
    if (timelineEl) timelineEl.classList.remove('learning');
}

function renderTimeline() {
    timelineEl.innerHTML = '';
    timelineEl.classList.toggle('learning', !hasPlacedBefore());

    for (let i = 0; i <= timeline.length; i++) {
        const gap = document.createElement('div');
        gap.className = 'timeline-gap';
        gap.dataset.index = i;

        // Spell out what this slot means. Needed for screen readers, and
        // doubly so on phones where the list is shown newest-first while the
        // DOM stays in chronological order.
        const before = timeline[i - 1];
        const after = timeline[i];
        let label;
        if (!before && !after)      label = 'Place the artwork on the timeline';
        else if (!before)           label = `Place before ${after.objectEndDate}`;
        else if (!after)            label = `Place after ${before.objectEndDate}`;
        else                        label = `Place between ${before.objectEndDate} and ${after.objectEndDate}`;

        gap.setAttribute('role', 'button');
        gap.setAttribute('tabindex', '0');
        gap.setAttribute('aria-label', label);

        // A real element for the button, rather than a ::before glyph. The
        // plus is drawn as two bars in CSS, so it cannot drift with the
        // font's metrics, and the circle is a plain flex item that centres
        // identically in the horizontal and vertical layouts.
        const btn = document.createElement('span');
        btn.className = 'gap-btn';
        btn.setAttribute('aria-hidden', 'true');
        gap.appendChild(btn);

        gap.addEventListener('click', () => placeCard(i));
        gap.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                placeCard(i);
            }
        });
        timelineEl.appendChild(gap);
        
        if (i < timeline.length) {
            const cardData = timeline[i];
            const cardEl = document.createElement('div');
            cardEl.className = 'card timeline-card';
            cardEl.innerHTML = `
                <div class="card-image-container">
                    <img src="${cardData.primaryImageSmall}" class="zoomable-img" alt="${cardData.title}">
                </div>
                <div class="card-details">
                    <h3>${cardData.title}</h3>
                    <p>${cardData.cleanArtist || (cardData.artistDisplayName ? cardData.artistDisplayName.trim() : 'Unknown')}</p>
                    <p class="year">${cardData.objectEndDate}</p>
                </div>
            `;
            timelineEl.appendChild(cardEl);
        }
    }
    setTimeout(() => {
        timelineEl.scrollLeft = timelineEl.scrollWidth;
    }, 100);
}

function placeCard(index) {
    if (!feedbackArea.classList.contains('hidden')) return;

    markPlaced();   // they have understood the slots; stop the hand-holding
    
    let isCorrect = true;
    const year = currentCard.objectEndDate;
    
    if (index > 0) {
        const prevYear = timeline[index - 1].objectEndDate;
        if (year < prevYear) isCorrect = false;
    }
    if (index < timeline.length) {
        const nextYear = timeline[index].objectEndDate;
        if (year > nextYear) isCorrect = false;
    }
    
    document.getElementById('active-details').classList.remove('hidden');
    document.getElementById('bonus-section').classList.add('hidden');
    feedbackArea.classList.remove('hidden');
    bonusFeedback.innerHTML = '';
    
    const triviaSection = document.getElementById('trivia-section');
    const triviaText = document.getElementById('trivia-text');
    if (currentCard.trivia) {
        triviaText.textContent = currentCard.trivia;
        triviaSection.classList.remove('hidden');
    } else {
        triviaSection.classList.add('hidden');
    }
    
    const dykSection = document.getElementById('did-you-know-section');
    const dykText = document.getElementById('did-you-know-text');
    if (currentCard.didYouKnow) {
        dykText.textContent = currentCard.didYouKnow;
        dykSection.classList.remove('hidden');
    } else {
        dykSection.classList.add('hidden');
    }
    
    track(isCorrect ? 'round-correct' : 'round-wrong');

    if (isCorrect) {
        feedbackMessage.textContent = 'Correctly placed!';
        feedbackMessage.className = 'success';
        score += 1;
        timeline.splice(index, 0, currentCard);
    } else {
        feedbackMessage.textContent = `Incorrect! The artwork is from ${year}.`;
        feedbackMessage.className = 'error';
        timelineEl.classList.add('shake');
        setTimeout(() => timelineEl.classList.remove('shake'), 500);
    }
    
    checkBonuses();
    updateScoreUI();
    renderTimeline();
    currentRound++;
}

function checkBonuses() {
    const guessArtist = document.getElementById('guess-artist').value.trim();
    const guessTitle = document.getElementById('guess-title').value.trim();
    const guessYear = document.getElementById('guess-year').value.trim();
    
    if (guessArtist) {
        if (fuzzyMatch(guessArtist, currentCard.cleanArtist)) {
            score += 1;
            bonusPoints += 1;
            addFeedbackItem(`Artist guessed correctly! (+1 Point)`, true);
        } else {
            addFeedbackItem(`Wrong artist (Was: ${currentCard.cleanArtist})`, false);
        }
    }
    
    if (guessTitle) {
        if (fuzzyMatch(guessTitle, currentCard.title)) {
            score += 1;
            bonusPoints += 1;
            addFeedbackItem(`Title guessed correctly! (+1 Point)`, true);
        } else {
            addFeedbackItem(`Wrong title (Was: ${currentCard.title})`, false);
        }
    }
    
    if (guessYear) {
        if (parseInt(guessYear) === currentCard.objectEndDate) {
            score += 2;
            bonusPoints += 2;
            addFeedbackItem(`Exact year guessed! (+2 Points)`, true);
        } else {
            addFeedbackItem(`Wrong year (Was: ${currentCard.objectEndDate})`, false);
        }
    }
}

function addFeedbackItem(text, isSuccess) {
    const li = document.createElement('li');
    li.textContent = text;
    li.style.color = isSuccess ? 'var(--success)' : 'var(--error)';
    bonusFeedback.appendChild(li);
}

function updateScoreUI() {
    document.getElementById('score').textContent = score;
}

function endGame() {
    track('game-complete');

    screens.game.classList.remove('active');
    screens.end.classList.add('active');
    
    document.getElementById('final-score').textContent = score;
    const bd = document.getElementById('score-breakdown');
    bd.innerHTML = `
        <p><span>Correct placements:</span> <span>${score - bonusPoints} / ${maxRounds}</span></p>
        <p><span>Bonus points:</span> <span>${bonusPoints}</span></p>
    `;
}

function fuzzyMatch(str1, str2) {
    if (!str1 || !str2) return false;
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s2.includes(s1) && s1.length > 3) return true;
    
    const distance = levenshtein(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    const threshold = Math.max(2, Math.floor(maxLength * 0.3));
    
    return distance <= threshold;
}

function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

// ==========================================
// NEW FEATURES: Gallery, Report, and Zoom
// ==========================================

// Gallery Logic
const galleryScreen = document.getElementById('gallery-screen');
const galleryGrid = document.getElementById('gallery-grid');
const galleryBtn = document.getElementById('gallery-btn');
const backToMenuBtn = document.getElementById('back-to-menu-btn');

galleryBtn.addEventListener('click', async () => {
    track('gallery-open');

    screens.start.classList.remove('active');
    galleryScreen.classList.add('active');
    
    galleryGrid.innerHTML = '<p>Loading gallery...</p>';
    try {
        const res = await fetch('artline.json', { cache: 'no-cache' });
        const data = await res.json();
        
        // Sort by year
        data.sort((a, b) => (a.year || 0) - (b.year || 0));
        
        galleryGrid.innerHTML = '';
        data.forEach(item => {
            const imgSrc = (item.image_local || item.image || '').replace(/\\\\/g, '/');
            if (!imgSrc) return;
            
            const div = document.createElement('div');
            div.className = 'gallery-card';
            div.innerHTML = `
                <img src="${imgSrc}" class="zoomable-img" alt="${item.title}" loading="lazy">
                <div class="gallery-details">
                    <h3>${item.title}</h3>
                    <p>${item.artist}</p>
                    <p class="year">${item.year}</p>
                </div>
            `;
            galleryGrid.appendChild(div);
        });
    } catch(e) {
        galleryGrid.innerHTML = '<p>Failed to load gallery.</p>';
    }
});

backToMenuBtn.addEventListener('click', () => {
    galleryScreen.classList.remove('active');
    screens.start.classList.add('active');
});

// Report Modal Logic
const reportBtn = document.getElementById('open-report-btn');
const reportModal = document.getElementById('report-modal');
const cancelReportBtn = document.getElementById('cancel-report-btn');
const sendReportBtn = document.getElementById('send-report-btn');
const reportText = document.getElementById('report-text');

const REPORT_EMAIL = 'julian@langschwerts.de';
const reportCardContext = document.getElementById('report-card-context');
const reportCardSummary = document.getElementById('report-card-summary');
const reportTopic = document.getElementById('report-topic');
const reportFallback = document.getElementById('report-fallback');
const reportFallbackText = document.getElementById('report-fallback-text');
const reportCopyBtn = document.getElementById('report-copy-btn');

// The card the player is currently looking at, if any. On the start screen,
// the gallery or the end screen there is none, and the report is general.
function reportContextCard() {
    return currentCard || null;
}

function resetReportModal() {
    reportFallback.classList.add('hidden');
    reportFallbackText.value = '';
    reportCopyBtn.textContent = 'Copy to clipboard';
    reportText.value = '';
}

reportBtn.addEventListener('click', () => {
    const card = reportContextCard();
    if (card) {
        reportCardSummary.textContent =
            [card.title, card.artist, card.year].filter(Boolean).join(' \u00b7 ');
        reportCardContext.classList.remove('hidden');
    } else {
        reportCardContext.classList.add('hidden');
    }
    reportModal.classList.remove('hidden');
});

cancelReportBtn.addEventListener('click', () => {
    reportModal.classList.add('hidden');
    resetReportModal();
});

function buildReportBody(text, topic, card) {
    const lines = [text, '', '---', 'Topic: ' + topic];
    if (card) {
        if (card.title) lines.push('Card: ' + card.title);
        if (card.artist) lines.push('Artist: ' + card.artist);
        if (card.year) lines.push('Year: ' + card.year);
        if (card.movement) lines.push('Movement: ' + card.movement);
        if (card.medium) lines.push('Medium: ' + card.medium);
        if (card.location) lines.push('Location: ' + card.location);
        if (card.source) lines.push('Source: ' + card.source);
        if (card.id) lines.push('Card ID: ' + card.id);
        lines.push('Round: ' + currentRound + ' of ' + maxRounds);
    }
    try { lines.push('Page: ' + window.location.href); } catch (e) {}
    return lines.join('\r\n');
}

sendReportBtn.addEventListener('click', () => {
    const text = reportText.value.trim();
    if (!text) {
        alert("Please enter some feedback before sending.");
        return;
    }

    const topic = reportTopic ? reportTopic.value : 'Something else';
    const card = reportContextCard();

    let subject = 'CIRCArt feedback: ' + topic;
    if (card && card.title) subject += ' \u2014 ' + card.title;

    const body = buildReportBody(text, topic, card);

    track('feedback-sent');

    // Show the copyable version FIRST. A mailto: can fail silently when no mail
    // client is configured, and the old code cleared the box and claimed the
    // feedback had been sent, so anything typed was simply lost.
    reportFallbackText.value = 'To: ' + REPORT_EMAIL + '\r\nSubject: ' + subject + '\r\n\r\n' + body;
    reportFallback.classList.remove('hidden');

    try {
        window.location.href = 'mailto:' + REPORT_EMAIL +
            '?subject=' + encodeURIComponent(subject) +
            '&body=' + encodeURIComponent(body);
    } catch (e) {
        // Leave the fallback on screen; there is nothing else to do.
    }
});

if (reportCopyBtn) {
    reportCopyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(reportFallbackText.value);
            reportCopyBtn.textContent = 'Copied';
        } catch (e) {
            reportFallbackText.select();          // older browsers / no permission
            reportCopyBtn.textContent = 'Press Ctrl+C';
        }
    });
}

// Zoom Modal Logic
const zoomModal = document.getElementById('zoom-modal');
const zoomedImage = document.getElementById('zoomed-image');
const closeZoomBtn = document.getElementById('close-zoom-btn');

document.body.addEventListener('click', (e) => {
    if (e.target.classList.contains('zoomable-img')) {
        zoomedImage.src = e.target.src;
        zoomModal.classList.remove('hidden');
    }
});

closeZoomBtn.addEventListener('click', () => {
    zoomModal.classList.add('hidden');
});

zoomModal.addEventListener('click', (e) => {
    if (e.target === zoomModal) {
        zoomModal.classList.add('hidden');
    }
});
