/*
 * Propos 4.0 Customer API -> Firebase sync
 * Draait via GitHub Actions (nachtelijk). Haalt productie-cijfers uit Propos
 * en schrijft een samengevatte payload naar Firestore (planning/propos_live),
 * waar het management-dashboard ze live uit leest.
 *
 * Secrets (GitHub repo > Settings > Secrets and variables > Actions):
 *   PROPOS_USER   = Klant-API gebruikersnaam (bv. api@obumex.be)
 *   PROPOS_PASS   = Klant-API wachtwoord
 *   FIREBASE_KEY  = Firebase web apiKey (publiek; staat ook in index.html)
 * Optioneel env:
 *   FIREBASE_PROJECT (default: obumex-werkplanning)
 *   MONTHS_BACK (default: 12)   WEEKS_AHEAD (default: 8)
 *
 * Vereist Node 20+ (global fetch).
 */
'use strict';

const BASE = 'https://www.propos-online.com';
const USER = process.env.PROPOS_USER;
const PASS = process.env.PROPOS_PASS;
const FB_PROJECT = process.env.FIREBASE_PROJECT || 'obumex-werkplanning';
const FB_KEY = process.env.FIREBASE_KEY;
const MONTHS_BACK = parseInt(process.env.MONTHS_BACK || '12', 10);
const WEEKS_AHEAD = parseInt(process.env.WEEKS_AHEAD || '8', 10);

if (!USER || !PASS) { console.error('Ontbrekende PROPOS_USER / PROPOS_PASS'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function isoDateTime(d) { return isoDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function baseProject(code) { const m = String(code || '').match(/^(P\d+-\d+(?:_\d+)?)/i); return m ? m[1] : String(code || ''); }
function isoWeekKey(d){var t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));var day=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-day);var ys=new Date(Date.UTC(t.getUTCFullYear(),0,1));var wk=Math.ceil((((t-ys)/86400000)+1)/7);return t.getUTCFullYear()+'-W'+(wk<10?'0'+wk:wk);}
async function fetchFirebaseKey() {
  if (FB_KEY) return FB_KEY;
  const r = await fetch('https://jensdecuyper-star.github.io/obumex-werkplanning/index.html', { cache: 'no-store' });
  const html = await r.text();
  const m = html.match(/apiKey\s*:\s*["']([^"']+)["']/);
  if (!m) throw new Error('Kon Firebase apiKey niet uit index.html halen');
  return m[1];
}

let TOKEN = null;
async function authenticate() {
  const r = await fetch(BASE + '/extapi/v1/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  if (!r.ok) throw new Error('Auth mislukt: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  TOKEN = j.id_token || j.idToken || j.token;
  if (!TOKEN) throw new Error('Geen id_token in auth-respons: ' + JSON.stringify(j).slice(0, 200));
  log('Geauthenticeerd.');
}

async function apiGet(path, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = BASE + path + (qs ? '?' + qs : '');
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } });
  if (!r.ok) throw new Error('GET ' + path + ' -> HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function getAllPages(path, params) {
  const size = 500; let page = 0; const out = []; let guard = 0;
  while (guard++ < 200) {
    const rows = await apiGet(path, Object.assign({}, params, { page, size }));
    const arr = Array.isArray(rows) ? rows : (rows.content || []);
    out.push(...arr);
    if (arr.length < size) break;
    page++;
  }
  return out;
}

async function main() {
  await authenticate();
  const now = new Date();
  const from = new Date(now); from.setMonth(from.getMonth() - MONTHS_BACK);
  const fromDT = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0).toISOString();
  const toDT = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

  log('Ophalen po-cells rapport...');
  const cells = await getAllPages('/extapi/v1/report/po-cells/search', { actualEndDtFrom: fromDT, actualEndDtTo: toDT });
  log('  po-cells:', cells.length);

  const perProject = {}, perCell = {};
  for (const c of cells) {
    const vc = ((c.sumPlannedTTPerson || 0) + (c.sumPlannedTTMachine || 0)) / 60;
    const nc = ((c.sumClockedTimePerson || 0) + (c.sumClockedTimeMachine || 0)) / 60;
    const wsp = (c.actualWsp || 0) / 60;
    const bp = baseProject(c.productionOrderCode);
    const p = perProject[bp] || (perProject[bp] = { vc: 0, nc: 0 });
    p.vc += vc; p.nc += nc;
    const cell = c.cellCode || '(onbekend)';
    const pc = perCell[cell] || (perCell[cell] = { plannedTT: 0, clockedTT: 0, wsp: 0, n: 0 });
    pc.plannedTT += vc; pc.clockedTT += nc; pc.wsp += wsp; pc.n += 1;
  }

  log('Ophalen scrap (po-cell-operations)...');
  let scrapByCell = {};
  try {
    const ops = await getAllPages('/extapi/v1/report/po-cell-operations/search', { actualEndDtFrom: fromDT, actualEndDtTo: toDT });
    log('  operations:', ops.length);
    for (const o of ops) {
      if (o.scrapQuantity) { const cell = o.cellCode || '(onbekend)'; scrapByCell[cell] = (scrapByCell[cell] || 0) + o.scrapQuantity; }
    }
  } catch (e) { log('  scrap overgeslagen:', e.message); }

  log('Ophalen capaciteit + planned-orders...');
  const capByCellWeek = {};
  try {
    const cap = await apiGet('/extapi/v1/report/capacity', { fromDt: isoDate(now), timePeriodType: 'WEEK', timePeriods: WEEKS_AHEAD });
    for (const row of (Array.isArray(cap) ? cap : [])) {
      const cell = row.cellCode || '(onbekend)'; const off = row.timePeriodOffset || 0;
      const w = (capByCellWeek[cell] || (capByCellWeek[cell] = {}));
      const e = (w[off] || (w[off] = { alloc: 0, load: 0, weekNr: row.timePeriodNr }));
      e.alloc += (row.allocatedWMin || 0) / 60;
    }
  } catch (e) { log('  capaciteit overgeslagen:', e.message); }
  try {
    const toDate = new Date(now); toDate.setDate(toDate.getDate() + WEEKS_AHEAD * 7);
    const planned = await getAllPages('/extapi/v1/report/planned-orders', { fromDt: isoDate(now), toDt: isoDate(toDate), timePeriodType: 'WEEK' });
    log('  planned-orders rows:', planned.length);
    for (const row of planned) {
      const cell = row.cellCode || '(onbekend)'; const wk = row.weekNr || '?';
      const w = (capByCellWeek[cell] || (capByCellWeek[cell] = {}));
      let key = Object.keys(w).find(k => String(w[k].weekNr) === String(wk));
      if (key == null) { key = 'w' + wk; if (!w[key]) w[key] = { alloc: 0, load: 0, weekNr: wk }; }
      w[key].load += (row.plannedWMin || 0) / 60;
    }
  } catch (e) { log('  planned-orders overgeslagen:', e.message); }

  let otd = null;
  var weekly = { finished: {}, "new": {}, byCell: { Bankwerk: {}, CNC: {} }, forecast: {}, forecastNext: [] };
  try {
    log('Ophalen orders + closed batches (OTD + weekreeksen)...');
    const orders = await getAllPages('/extapi/v1/production-orders/search', { archived: false });
    const reqByBatch = {};
    for (const o of orders) {
      for (const b of (o.poBatches || [])) {
        if (b.extCreatedDt) { var nk = isoWeekKey(new Date(b.extCreatedDt)); weekly["new"][nk] = (weekly["new"][nk] || 0) + 1; }
      }
      if (o.relevantForOnTimeDelivery === false || o.parentCode) continue;
      for (const b of (o.poBatches || [])) {
        const red = b.overrideRequiredEndDt || b.requiredEndDt;
        if (red) reqByBatch[o.code + '||' + b.code] = { req: red, cust: o.customerName || '' };
      }
    }
    const closed = await getAllPages('/extapi/v1/report/po-batches/closed', { actualEndDtFrom: fromDT, actualEndDtTo: toDT });
    let on = 0, late = 0, byCust = {};
    for (const b of closed) {
      if (b.actualEndDt) { var fk = isoWeekKey(new Date(b.actualEndDt)); weekly.finished[fk] = (weekly.finished[fk] || 0) + 1; }
      const ref = reqByBatch[b.productionOrderCode + '||' + b.code];
      if (!ref || !b.actualEndDt) continue;
      const lateF = new Date(b.actualEndDt) > new Date(ref.req);
      if (lateF) late++; else on++;
      const cc = byCust[ref.cust || '(onbekend)'] || (byCust[ref.cust || '(onbekend)'] = { on: 0, late: 0 });
      if (lateF) cc.late++; else cc.on++;
    }
    if (on + late > 0) otd = { onTime: on, late: late, pct: Math.round(on / (on + late) * 100), byCustomer: byCust };
    log('  OTD:', otd ? otd.pct + '% (' + (on + late) + ' orders)' : 'geen data');
  } catch (e) { log('  OTD/weekreeksen overgeslagen:', e.message); }

  try {
    cells.forEach(function (c) { if (!c.actualEndDt) return; var cell = String(c.cellCode || ''); var t = /bankwerk/i.test(cell) ? 'Bankwerk' : (/cnc/i.test(cell) ? 'CNC' : null); if (t) { var k = isoWeekKey(new Date(c.actualEndDt)); weekly.byCell[t][k] = (weekly.byCell[t][k] || 0) + 1; } });
  } catch (e) { log('  byCell overgeslagen:', e.message); }

  try {
    var openB = await getAllPages('/extapi/v1/report/po-batches/open', { includeCells: true });
    log('  open batches (prognose):', openB.length);
    var nextK = isoWeekKey(new Date(Date.now() + 7 * 86400000));
    openB.forEach(function (b) {
      if (b.ready) return;
      var maxEnd = null;
      (b.poCells || []).forEach(function (pc) { if (pc.planEndDt) { var t = new Date(pc.planEndDt).getTime(); if (maxEnd == null || t > maxEnd) maxEnd = t; } });
      if (maxEnd == null) return;
      var k = isoWeekKey(new Date(maxEnd));
      weekly.forecast[k] = (weekly.forecast[k] || 0) + 1;
      if (k === nextK) weekly.forecastNext.push({ po: b.productionOrderCode + '-' + b.code, oms: b.itemCode || '' });
    });
  } catch (e) { log('  prognose overgeslagen:', e.message); }

  const payload = { updatedAt: new Date().toISOString(), window: { fromDT, toDT, weeksAhead: WEEKS_AHEAD }, perProject, perCell, scrapByCell, capByCellWeek, otd, weekly };

  const fbKey = await fetchFirebaseKey();
  const url = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT +
    '/databases/(default)/documents/planning/propos_live?key=' + fbKey +
    '&updateMask.fieldPaths=payload&updateMask.fieldPaths=updatedAt';
  const body = { fields: { payload: { stringValue: JSON.stringify(payload) }, updatedAt: { stringValue: payload.updatedAt } } };
  const wr = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!wr.ok) throw new Error('Firestore schrijven mislukt: HTTP ' + wr.status + ' ' + (await wr.text()).slice(0, 300));
  log('Weggeschreven naar planning/propos_live. Projecten:', Object.keys(perProject).length, '| Cellen:', Object.keys(perCell).length);
}
main().catch(e => { console.error('FOUT:', e.message); process.exit(1); });
