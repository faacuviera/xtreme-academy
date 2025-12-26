/** Xtreme Academy - Cuentas (PWA)
 *  - Guardado local en IndexedDB
 *  - Plantillas (meses) con tablas: ingresos, gastos, cxc, cxp, inventario
 */
import {
  money,
  todayISO,
  monthISO,
  uid,
  csvEscape,
  toCSV,
  download
} from "./utils.js";

const $ = (id)=>document.getElementById(id);
/* ---------- Logging & non-fatal notifications ---------- */
function createLogger(scope) {
  const prefix = `[${scope}]`;
  const emit = (level, ...args) => {
    const fn = console[level] || console.log;
    fn.call(console, prefix, ...args);
  };
  return {
    info: (...args) => emit("info", ...args),
    warn: (...args) => emit("warn", ...args),
    error: (...args) => emit("error", ...args)
  };
}

const log = createLogger("XA");
const storageStats = { failures: 0 };

function showSoftBanner(message) {
  const host = document.getElementById("appAlerts");
  if (!host || !message) return;

  const el = document.createElement("div");
  el.className = "app-alert";
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 200);
  }, 5200);
}

function recordStorageFailure(context, err) {
  storageStats.failures += 1;
  log.warn(`Fallo de almacenamiento (#${storageStats.failures}) en ${context}`, err);
  showSoftBanner("⚠️ Problema guardando datos locales. Revisá tu navegador.");
}

// 🔎 DEBUG: mostrar errores en pantalla (iPhone friendly) sin bloquear la UI
window.addEventListener("error", (e) => {
  const msg = "JS ERROR: " + (e.message || e.type) + " " + (e.filename || "") + ":" + (e.lineno || "");
  log.error(msg, e.error || e);
  showSoftBanner(msg);
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = "PROMISE ERROR: " + (e.reason?.message || JSON.stringify(e.reason) || String(e.reason) || "unknown");
  log.error(msg, e.reason || e);
  showSoftBanner(msg);
});

// ===== MODO EDICIÓN (GLOBAL) =====
let editMode = {
  section: null, // "alumnos" | "cxc" | "ingresos" | "gastos" | "cxp"
  id: null
};

// ===== Active data (GLOBAL) =====
const XA_STORE_KEY = "xa_store_v1";
const XA_ACTIVE_KEY = "xa_active_v1";
const LOCAL_STORAGE_BUDGET = 4.5 * 1024 * 1024; // ~4.5MB

function safeSetItem(key, value) {
  const isString = typeof value === "string";
  const payload = isString ? value : JSON.stringify(value || {});
  if (payload.length > LOCAL_STORAGE_BUDGET) {
    recordStorageFailure(`escritura localStorage (${key})`, new Error("Payload demasiado grande para localStorage"));
    return;
  }
  try {
    localStorage.setItem(key, payload);
    return;
  } catch (err) {
    log.warn("Primer intento de guardado falló, reintentando con limpieza", { key, err });
  }

  try {
    localStorage.removeItem(key);
    localStorage.setItem(key, payload);
  } catch (err2) {
    recordStorageFailure(`escritura localStorage (${key})`, err2);
  }
}

function xaLoad() {
  try { return JSON.parse(localStorage.getItem(XA_STORE_KEY)) || {}; }
  catch (err) {
    recordStorageFailure("lectura localStorage", err);
    return {};
  }
}

function xaSave(store) {
  safeSetItem(XA_STORE_KEY, store || {});
}

function getActiveId() {
  return localStorage.getItem(XA_ACTIVE_KEY) || "default";
}

function setActiveId(id) {
  safeSetItem(XA_ACTIVE_KEY, id);
}

function getActive() {
  const store = xaLoad();
  const id = getActiveId();

  store[id] ??= {
    alumnos: [],
    ingresos: [],
    gastos: [],
    pagos: [],
    asistencia: [],
    cxc: [],
    cxp: [],
    inventario: []
  };

  const tplName = getTemplateName(state?.templates?.find((t) => t.id === id)) || store[id].name || id;
  if (tplName) {
    store[id].name = tplName;
  }

  // 🔥 MIGRACIÓN: datos viejos con Cxc → cxc
  if (store[id].Cxc && !store[id].cxc) {
    store[id].cxc = store[id].Cxc;
    delete store[id].Cxc;
  }

  // asegurar arrays
  store[id].cxc ??= [];
  store[id].cxp ??= [];
  store[id].ingresos ??= [];
  store[id].gastos ??= [];
  store[id].pagos ??= [];
  store[id].asistencia ??= [];
  store[id].alumnos ??= [];
  store[id].inventario ??= [];

  xaSave(store);
  return store[id];
}

function setActive(active) {
  const store = xaLoad();
  const id = getActiveId();

  store[id] = active;

  // asegurar arrays por las dudas (mismo criterio que getActive)
  store[id].cxc ??= [];
  store[id].cxp ??= [];
  store[id].ingresos ??= [];
  store[id].gastos ??= [];
  store[id].pagos ??= [];
  store[id].asistencia ??= [];
  store[id].alumnos ??= [];
  store[id].inventario ??= [];

  xaSave(store);
}


function ensurecxc(active){
  if (!Array.isArray(active.cxc)) active.cxc = [];
}

function addCuotaPendiente(active, alumno) {
  if (!active || !alumno) return;

  active.cxc ??= [];

  // evitar duplicar cuotas pendientes para el mismo alumno
  const existe = active.cxc.some(c =>
    String(c.alumnoId || "") === String(alumno.id) &&
    String(c.estado || "").toLowerCase() !== "pagado"
  );

  if (existe) return;

  active.cxc.push({
    id: "cxc_" + uid(),
   vence: venceDia10ISO(),
    nombre: alumno.nombre || "",
    concepto: "Cuota mensual",
    monto: Number(alumno.cuota || 0),
    estado: "Pendiente",
    notas: "",
    alumnoId: alumno.id
  });
}


/* ---------- IndexedDB minimal wrapper ---------- */
const DB_NAME = "xtremeCuentasDB";
const DB_VER = 2;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;

      // Crear store si no existe
      let templates;
      if (!db.objectStoreNames.contains("templates")) {
        templates = db.createObjectStore("templates", { keyPath: "id" });
      } else {
        templates = req.transaction.objectStore("templates");
      }

      // ✅ Asegurar que byName NO sea único (porque podés tener nombres repetidos)
      if (templates.indexNames.contains("byName")) {
        templates.deleteIndex("byName");
      }
      templates.createIndex("byName", "name", { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      recordStorageFailure("apertura IndexedDB", req.error);
      reject(req.error);
    };
  });
}

async function dbGetAll(store){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readonly");
    const st=tx.objectStore(store);
    const req=st.getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
async function dbPut(store, value){
  const db = await openDB();

  if (value && (value.id === undefined || value.id === null || value.id === "")) {
    value.id = uid();
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    const req = os.put(value);

    req.onerror = () => reject(req.error || tx.error || new Error("dbPut request failed"));
    tx.onerror  = () => reject(tx.error || new Error("dbPut tx failed"));
    tx.onabort  = () => reject(tx.error || new Error("dbPut aborted"));
    tx.oncomplete = () => resolve(true);
  });
}


async function dbDelete(store, key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error);
    tx.objectStore(store).delete(key);
  });
}

/* ---------- State ---------- */
let state = {
  templates: [],
  activeTemplateId: null,
  active: null, // current template object
  filters: { month: monthISO(), search: "" }
};

function getTemplateName(tpl) {
  return String(tpl?.name || tpl?.nombre || "").trim();
}

function sortTemplates(list) {
  return (list || []).sort((a, b) => getTemplateName(a).localeCompare(getTemplateName(b)));
}

function emptyTemplate(name){
  return {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ingresos: [],
    gastos: [],
    cxc: [],
    cxp: [],
    inventario: [],
    alumnos: []
  };
}

function cloneTemplate(fromTpl, name){
  const t = emptyTemplate(name);
  // Carry over inventario + cuentas by default; ingresos/gastos are per month
  t.inventario = (fromTpl.inventario||[]).map(x=>({...x, id: uid()}));
  t.alumnos = (fromTpl.alumnos||[]).map(a => ({ ...a, id: uid() }));
  t.cxc = (fromTpl.cxc||[]).map(x=>({...x, id: uid()}));
  t.cxp = (fromTpl.cxp||[]).map(x=>({...x, id: uid()}));
  return t;
}

/* ---------- Bootstrap ---------- */
async function init(){
  // Default dates
  ["inFecha","gaFecha","cxcvence","cxpvence"].forEach(id=>{
    if($(id)) $(id).value = todayISO();
  });
  $("monthFilter").value = state.filters.month;

  // Load templates
  const templates = await dbGetAll("templates");
  state.templates = sortTemplates(templates);

  // Create first template if none
  if (state.templates.length === 0) {
    const name = monthISO();
    const t = emptyTemplate(name);
    t.name = name;
    await dbPut("templates", t);
    state.templates = [t];
  }

  // Determine active template
  const savedActive = localStorage.getItem("xt_active_template");
  const tpl =
    state.templates.find(x => x.id === savedActive) ||
    state.templates[state.templates.length - 1];

  safeSetItem("xt_active_template", tpl.id);
  state.activeTemplateId = tpl.id;
  setActiveId(tpl.id);

  // Load active data
  state.active = getActive();

  // asegurar arrays
  state.active.cxc ??= [];
  state.active.ingresos ??= [];
  state.active.gastos ??= [];
  state.active.pagos ??= [];
  state.active.asistencia ??= [];
  state.active.alumnos ??= [];

  // UI wiring
  wireTabs();
  wireActions();
  setupInlineEditHotkeys();
  updateTabHero(document.querySelector(".nav button.active")?.dataset.tab || "dashboard");

  // Render
  refreshTemplateSelectors();
  renderAll();
}


function saveActive(){
  safeSetItem("xt_active_template", state.activeTemplateId);
}

function saveActiveData(active) {
  const store = xaLoad();
  const id = getActiveId();

  // ✅ aseguramos que cxc se guarde siempre
  active.cxc = active.cxc || [];

  store[id] = active;
  xaSave(store);
}


function setActiveTemplate(id){
  const t = state.templates.find(x=>x.id===id);
  if(!t) return;

  state.activeTemplateId = id;

  // ✅ cambia el "store" activo a esta plantilla
  setActiveId(id);

  // ✅ carga datos de esa plantilla
  state.active = getActive();

  saveActive(); // esto guarda xt_active_template (selector)
  renderAll();
}

/* ---------- Tabs ---------- */
function updateTabHero(tab){
  const hero = $("tabHero");
  if (!hero) return;

  const visual = TAB_VISUALS[tab] || TAB_VISUALS.dashboard;
  hero.style.setProperty("--hero-image", `url("${visual.src}")`);
}

function wireTabs(){
  document.querySelectorAll(".nav button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".nav button").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const tab=btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(s=>s.hidden=true);
      $("tab-"+tab).hidden=false;
      updateTabHero(tab);
    });
  });
}

/* ---------- Helpers ---------- */
function venceDia10ISO() {
  const tpl = state.templates?.find(t => t.id === state.activeTemplateId);
  const name = (tpl?.name || "").trim();

  const m = name.match(/(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-10`;

  const today = todayISO();
  return `${today.slice(0, 7)}-10`;
}

function persistActive(activeParam){
  const active = activeParam || state.active || getActive();

  // ✅ clave: persistir SIEMPRE con el id de la plantilla activa
  const id = getActiveId();
  active.id = id;

  // nombre por si falta
  active.name ||= monthISO();

  active.updatedAt = Date.now();
  state.active = active;

  // ✅ guardar también en localStorage para que el store activo quede en sync
  saveActiveData(active);

  return dbPut("templates", active).then(async () => {
    state.templates = sortTemplates(await dbGetAll("templates"));

    refreshTemplateSelectors();
  });
}


function inMonth(dateISO, monthYYYYMM){
  if(!dateISO) return false;
  return String(dateISO).slice(0,7)===monthYYYYMM;
}

function textMatch(obj, q){
  if(!q) return true;
  const s = JSON.stringify(obj).toLowerCase();
  return s.includes(q.toLowerCase());
}

function collectGlobalSearchHits(query){
  const term = (query || "").trim();
  if (!term) return [];

  const store = xaLoad() || {};
  const templates = state.templates?.length ? state.templates : [];
  const tplList = templates.length ? templates : Object.keys(store || {}).map(id => ({ id, name: id }));
  const ensureArray = (arr) => Array.isArray(arr) ? arr : [];

  const sections = [
    {
      key: "ingresos",
      label: "Ingreso",
      dateKey: "fecha",
      amountKey: "monto",
      title: (r) => r.nombre || r.concepto || "Ingreso",
      subtitle: (r) => r.concepto || r.medio || ""
    },
    {
      key: "gastos",
      label: "Egreso",
      dateKey: "fecha",
      amountKey: "monto",
      title: (r) => r.concepto || "Egreso",
      subtitle: (r) => r.categoria || ""
    },
    {
      key: "cxc",
      label: "Por cobrar",
      dateKey: "vence",
      amountKey: "monto",
      title: (r) => r.nombre || r.concepto || "Por cobrar",
      subtitle: (r) => r.concepto || ""
    },
    {
      key: "cxp",
      label: "Por pagar",
      dateKey: "vence",
      amountKey: "monto",
      title: (r) => r.proveedor || r.concepto || "Por pagar",
      subtitle: (r) => r.concepto || ""
    },
    {
      key: "inventario",
      label: "Inventario",
      dateKey: "",
      amountKey: null,
      title: (r) => r.producto || r.categoria || "Inventario",
      subtitle: (r) => {
        const stock = r.stock ?? "";
        const min = r.minimo ?? "";
        if (stock === "" && min === "") return "";
        return `Stock: ${stock}${min !== "" ? ` (mín ${min})` : ""}`;
      }
    },
    {
      key: "alumnos",
      label: "Alumno",
      dateKey: "",
      amountKey: null,
      title: (r) => r.nombre || "Alumno",
      subtitle: (r) => r.programa || (r.cuota ? `Cuota: ${money(Number(r.cuota) || 0)}` : "")
    }
  ];

  const hits = [];

  for (const tpl of tplList) {
    const tplData = store?.[tpl.id] || tpl || {};
    const tplName = getTemplateName(tpl) || tplData.name || tpl.id || "Plantilla";

    for (const section of sections) {
      const rows = ensureArray(tplData[section.key]);
      for (const row of rows) {
        const searchable = { ...row, plantilla: tplName };
        if (!textMatch(searchable, term)) continue;

        const amount = section.amountKey !== null && section.amountKey !== undefined
          ? Number(row?.[section.amountKey])
          : null;

        hits.push({
          tplId: tpl.id,
          tplName,
          section: section.label,
          date: section.dateKey ? (row?.[section.dateKey] || "") : "",
          title: section.title(row),
          subtitle: section.subtitle ? section.subtitle(row) : "",
          amount: Number.isFinite(amount) ? amount : null,
          estado: row?.estado || ""
        });
      }
    }
  }

  return hits;
}

function noteHtml(txt){
  const note = (txt || "").trim();
  if (!note) return `<span class="note-empty">—</span>`;
  return `<div class="note-text">${escAttr(note)}</div>`;
}

function requireDateValue(value, contextLabel){
  const v = (value || "").trim();
  if (!v) {
    alert(`Ingresá la fecha de ${contextLabel}; no puede quedar vacía.`);
    return null;
  }
  return v;
}

function requireMontoValue(value, contextLabel){
  const raw = value ?? "";
  if (String(raw).trim() === "") {
    alert(`Ingresá el monto de ${contextLabel}; no puede quedar vacío.`);
    return null;
  }
  const monto = Number(raw);
  if (Number.isNaN(monto)) {
    alert(`El monto de ${contextLabel} tiene que ser un número válido.`);
    return null;
  }
  if (monto < 0) {
    alert(`El monto de ${contextLabel} no puede ser negativo.`);
    return null;
  }
  return monto;
}

/* ---------- Rendering ---------- */
function render(){
  renderAll();
}



function renderAll(){
  state.active = getActive();

  state.active.cxc ??= [];
  state.active.cxp ??= [];
  state.active.ingresos ??= [];
  state.active.gastos ??= [];
  state.active.pagos ??= [];
  state.active.asistencia ??= [];
  state.active.alumnos ??= [];
  state.active.inventario ??= [];
  $("activeTemplateLabel").textContent = "Plantilla: " + state.active.name;
  $("monthFilter").value = state.filters.month;

  renderDashboard();
  renderIngresos();
  renderGastos();
  rendercxc();
  renderCxp();
  renderInventario();
  renderAlumnos();
}

function renderDashboard(){
  const m = state.filters.month;
  const q = state.filters.search;

  const ing = (state.active.ingresos||[]).filter(x=>inMonth(x.fecha,m) && textMatch(x,q));
  const gas = (state.active.gastos||[]).filter(x=>inMonth(x.fecha,m) && textMatch(x,q));

  const sumIng = ing.reduce((a,b)=>a+Number(b.monto||0),0);
  const sumGas = gas.reduce((a,b)=>a+Number(b.monto||0),0);
  const bal = sumIng - sumGas;

  $("kpiIngresos").textContent = money(sumIng);
  $("kpiGastos").textContent = money(sumGas);
  $("kpiBalance").textContent = money(bal);
  $("kpiHint").textContent = bal>=0 ? "Vas arriba 💪" : "Ojo: estás en negativo";

  // Set badge hints for overdue payables/receivables (not shown in KPI)

  renderSearchResultsAcrossTemplates(q);
}

function renderSearchResultsAcrossTemplates(query){
  const wrap = $("searchResults");
  const list = $("searchResultsList");
  const count = $("searchResultsCount");
  if (!wrap || !list || !count) return;

  const term = (query || "").trim();
  if (!term) {
    count.textContent = "Buscá por nombre, concepto o proveedor.";
    list.innerHTML = `<div class="empty">Escribí algo en “Búsqueda rápida” para ver coincidencias.</div>`;
    return;
  }

  const hits = collectGlobalSearchHits(term);
  const maxToShow = 80;
  const plural = hits.length === 1 ? "" : "s";
  count.textContent = hits.length
    ? `${hits.length} coincidencia${plural} en tus plantillas`
    : "Sin coincidencias en tus plantillas.";

  list.innerHTML = "";

  if (!hits.length) {
    list.innerHTML = `<div class="empty">Probá con otro término o revisá si está en otro mes.</div>`;
    return;
  }

  hits.slice(0, maxToShow).forEach((hit) => {
    const metaParts = [];
    if (hit.date) metaParts.push(hit.date);
    if (hit.estado) metaParts.push(hit.estado);

    const row = document.createElement("div");
    row.className = "search-hit";
    row.innerHTML = `
      <div class="search-hit__main">
        <div class="search-hit__label">${escAttr(hit.section)} · ${escAttr(hit.tplName)}</div>
        <div class="search-hit__title">${escAttr(hit.title)}</div>
        ${hit.subtitle ? `<div class="search-hit__subtitle">${escAttr(hit.subtitle)}</div>` : ""}
        ${metaParts.length ? `<div class="search-hit__meta">${escAttr(metaParts.join(" • "))}</div>` : ""}
      </div>
      ${hit.amount !== null ? `<div class="search-hit__amount">${money(hit.amount)}</div>` : ""}
    `;
    list.appendChild(row);
  });

  if (hits.length > maxToShow) {
    const more = document.createElement("div");
    more.className = "small";
    more.textContent = `Mostrando ${maxToShow} de ${hits.length} coincidencias. Refiná la búsqueda para acotar el resultado.`;
    list.appendChild(more);
  }
}

function renderIngresos(){
  const q = $("ingSearch").value || "";
  const rows = (state.active.ingresos || [])
    .filter(x => textMatch(x, q))
    .sort((a,b) => (b.fecha || "").localeCompare(a.fecha || ""));

  $("ingCount").textContent = String(rows.length);

  const tbody = $("ingTbody");
  tbody.innerHTML = "";

  for (const r of rows){
    const editing = (editMode.section === "ingresos" && editMode.id === r.id);
    const tr = document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.fecha||"")}</th>
        <td>${escAttr(r.nombre||"")}</td>
        <td>${escAttr(r.concepto||"")}</td>
        <td>${money(r.monto||0)}</td>
        <td>${escAttr(r.medio||"")}</td>
        <td><span class="badge ${r.estado==="Pagado"?"ok":""}">${escAttr(r.estado||"")}</span></td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar ingreso ${escAttr(r.concepto||"")} de ${escAttr(r.nombre||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar ingreso ${escAttr(r.concepto||"")} de ${escAttr(r.nombre||"")}">Borrar</button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        <td><input id="ed_ing_fecha_${r.id}" type="date" value="${escAttr(r.fecha||"")}" /></td>
        <td><input id="ed_ing_nombre_${r.id}" value="${escAttr(r.nombre||"")}" /></td>
        <td><input id="ed_ing_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_ing_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td><input id="ed_ing_medio_${r.id}" value="${escAttr(r.medio||"")}" /></td>
        <td>
          <select id="ed_ing_estado_${r.id}">
            <option value="" ${!r.estado ? "selected" : ""}></option>
            <option value="Pagado" ${r.estado==="Pagado" ? "selected" : ""}>Pagado</option>
            <option value="Pendiente" ${r.estado==="Pendiente" ? "selected" : ""}>Pendiente</option>
          </select>
        </td>
        <td><textarea id="ed_ing_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>
      `;
    }

    tbody.appendChild(tr);
  }

  // Delegación (como CxC)
  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if (act === "del") delRow("ingresos", id);
    else if (act === "edit") editIngreso(id);
    else if (act === "save") saveIngreso(id);
    else if (act === "cancel") cancelEdit();
  };
}

function renderGastos(){
  const q = $("gasSearch").value || "";
  const rows = (state.active.gastos || [])
    .filter(x => textMatch(x, q))
    .sort((a,b)=> String(b.fecha||"").localeCompare(String(a.fecha||"")));

  $("gasCount").textContent = String(rows.length);

  const tbody = $("gasTbody");
  tbody.innerHTML = "";

  for(const r of rows){
    const editing = (editMode.section === "gastos" && editMode.id === r.id);
    const tr = document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.fecha||"")}</th>
        <td>${escAttr(r.concepto||"")}</td>
        <td>${escAttr(r.categoria||"")}</td>
        <td>${money(r.monto||0)}</td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar egreso ${escAttr(r.concepto||"")} del ${escAttr(r.fecha||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar egreso ${escAttr(r.concepto||"")} del ${escAttr(r.fecha||"")}">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_gas_fecha_${r.id}" type="date" value="${escAttr(r.fecha||"")}" /></td>
        <td><input id="ed_gas_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_gas_categoria_${r.id}" value="${escAttr(r.categoria||"")}" /></td>
        <td><input id="ed_gas_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td><textarea id="ed_gas_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>`;
    }
    tbody.appendChild(tr);
  }

  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if (act === "del") delRow("gastos", id);
    else if (act === "edit") editGasto(id);
    else if (act === "save") saveGasto(id);
    else if (act === "cancel") cancelEdit();
  };
}


function Paid(id){
  const store = xaLoad();
  const aid = getActiveId();
  const active = store[aid];
  if (!active) return;

  active.cxc ??= [];

  const cxc = active.cxc.find(c => c.id === id);
  if (!cxc) return;

  // marcar pagado
  cxc.estado = "Pagado";
  cxc.pagadoEn = todayISO();

  // crear pago
  active.pagos ??= [];
  active.pagos.push({
    id: "pay_" + uid(),
    fecha: todayISO(),
    concepto: cxc.concepto || "Cuota",
    nombre: cxc.nombre,
    monto: Number(cxc.monto || 0),
    origen: "CXC",
    refId: cxc.id
  });

  // guardar store
  store[aid] = active;
  xaSave(store);

  state.active = active;

  // refrescar UI
  rendercxc();
  renderIngresos?.();
  renderResumen?.();
}

function editCxc(id) {
  startEdit("cxc", id);
}

function saveCxc(id) {
  const venceRaw = document.getElementById(`ed_cxc_vence_${id}`)?.value || "";
  const nombre   = document.getElementById(`ed_cxc_nombre_${id}`)?.value.trim() || "";
  const concepto = document.getElementById(`ed_cxc_concepto_${id}`)?.value.trim() || "";
  const montoStr = document.getElementById(`ed_cxc_monto_${id}`)?.value || "0";
  const estado   = document.getElementById(`ed_cxc_estado_${id}`)?.value || "";
  const notas    = document.getElementById(`ed_cxc_notas_${id}`)?.value || "";

  const vence = requireDateValue(venceRaw, "esta cuenta por cobrar");
  if (!vence) return;
  const monto = requireMontoValue(montoStr, "esta cuenta por cobrar");
  if (monto === null) return;
  if (!nombre) return alert("El nombre no puede quedar vacío.");
  if (!concepto) return alert("El concepto no puede quedar vacío.");

  const active = getActive();
  const arr = active.cxc || [];

  active.cxc = arr.map(r => {
    if (r.id !== id) return r;
    return { ...r, vence, nombre, concepto, monto, estado, notas };
  });

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
}

window.editCxc = editCxc;
window.saveCxc = saveCxc;

// ===== INGRESOS: acciones =====
function editIngreso(id){
  startEdit("ingresos", id);
}

function saveIngreso(id){
  const fecha    = requireDateValue(document.getElementById(`ed_ing_fecha_${id}`)?.value, "este ingreso");
  const nombre   = document.getElementById(`ed_ing_nombre_${id}`)?.value.trim() || "";
  const concepto = document.getElementById(`ed_ing_concepto_${id}`)?.value.trim() || "";
  const montoStr = document.getElementById(`ed_ing_monto_${id}`)?.value || "0";
  const medio    = document.getElementById(`ed_ing_medio_${id}`)?.value.trim() || "";
  const estado   = document.getElementById(`ed_ing_estado_${id}`)?.value || "";
  const notas    = document.getElementById(`ed_ing_notas_${id}`)?.value || "";

  if (!fecha) return;
  const monto = requireMontoValue(montoStr, "este ingreso");
  if (!concepto) return alert("El concepto no puede quedar vacío.");
  if (monto === null) return;

  const active = getActive();
  active.ingresos = (active.ingresos || []).map(r =>
    r.id === id ? { ...r, fecha, nombre, concepto, monto, medio, estado, notas } : r
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render(); // tu wrapper -> renderAll()
}

window.editIngreso = editIngreso;
window.saveIngreso = saveIngreso;

// ===== GASTOS: acciones =====
function editGasto(id) {
  startEdit("gastos", id);
}

function saveGasto(id) {
  const fecha    = requireDateValue(document.getElementById(`ed_gas_fecha_${id}`)?.value, "este egreso");
  const concepto = document.getElementById(`ed_gas_concepto_${id}`)?.value.trim() || "";
  const categoria= document.getElementById(`ed_gas_categoria_${id}`)?.value.trim() || "";
  const montoStr = document.getElementById(`ed_gas_monto_${id}`)?.value || "0";
  const notas    = document.getElementById(`ed_gas_notas_${id}`)?.value || "";

  if (!fecha) return;
  const monto = requireMontoValue(montoStr, "este egreso");
  if (!concepto) return alert("El concepto no puede quedar vacío.");
  if (monto === null) return;

  const active = getActive();
  active.gastos = (active.gastos || []).map(r =>
    r.id === id ? { ...r, fecha, concepto, categoria, monto, notas } : r
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
}

window.editGasto = editGasto;
window.saveGasto = saveGasto;


function rendercxc(){
  const q = ($("cxcSearch").value || "").trim();
  const active = state.active ?? getActive();

  const rows = (active.cxc || [])
    .filter(x => !q || textMatch(x, q))
    .sort((a,b)=>(a.vence||"").localeCompare(b.vence||""));

  const pendingCount = rows.filter(r => String(r.estado || "").toLowerCase() !== "pagado").length;
  $("cxcCount").textContent = String(pendingCount);

  const tbody = $("cxcTbody");
  tbody.innerHTML = "";

  const now = todayISO();

  for(const r of rows){
    const isPaid = String(r.estado || "").toLowerCase() === "pagado";
    const overdue = !isPaid && r.vence && r.vence < now;
    const badgeClass = isPaid ? "ok" : (overdue ? "due" : "");

    const editing = (editMode.section === "cxc" && editMode.id === r.id);

    const tr = document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.vence||"")}</th>
        <td>${escAttr(r.nombre||"")}</td>
        <td>${escAttr(r.concepto||"")}</td>
        <td>${money(r.monto||0)}</td>
        <td><span class="badge ${badgeClass}">${overdue ? "Vencido" : (r.estado||"")}</span></td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          ${
  String(r.estado || "").toLowerCase() !== "pagado"
    ? `<button class="ghost" data-act="pay" data-id="${r.id}" aria-label="Marcar pagado ${escAttr(r.concepto||"")} de ${escAttr(r.nombre||"")}">Marcar pagado</button>`
    : ""
}
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar CxC ${escAttr(r.concepto||"")} de ${escAttr(r.nombre||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar CxC ${escAttr(r.concepto||"")} de ${escAttr(r.nombre||"")}">Borrar</button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        <td><input id="ed_cxc_vence_${r.id}" type="date" value="${escAttr(r.vence||"")}" /></td>
        <td><input id="ed_cxc_nombre_${r.id}" value="${escAttr(r.nombre||"")}" /></td>
        <td><input id="ed_cxc_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_cxc_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td>
          <select id="ed_cxc_estado_${r.id}">
            <option value="" ${!r.estado ? "selected" : ""}></option>
            <option value="Pendiente" ${r.estado==="Pendiente" ? "selected" : ""}>Pendiente</option>
            <option value="Pagado" ${r.estado==="Pagado" ? "selected" : ""}>Pagado</option>
          </select>
        </td>
        <td><textarea id="ed_cxc_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>
      `;
    }

    tbody.appendChild(tr);
  }

  tbody.onclick = (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;

  const act = btn.dataset.act;
  const id = btn.dataset.id;

  if (act === "del") delRow("cxc", id);
  else if (act === "edit") editCxc(id);
  else if (act === "save") saveCxc(id);
  else if (act === "cancel") cancelEdit();
  else if (act === "pay") window.markCxcPaid(id);
};

}


function renderCxp(){
  const q = $("cxpSearch").value || "";
  const rows = (state.active.cxp||[])
    .filter(x=>textMatch(x,q))
    .sort((a,b)=>(a.vence||"").localeCompare(b.vence||""));

  $("cxpCount").textContent = String(rows.length);
  const tbody = $("cxpTbody");
  tbody.innerHTML="";
  const now = todayISO();
  for(const r of rows){
    const editing = (editMode.section === "cxp" && editMode.id === r.id);
    const overdue = r.estado!=="Pagado" && r.vence && r.vence < now;
    const badgeClass = r.estado==="Pagado" ? "ok" : (overdue ? "due" : "");
    const tr=document.createElement("tr");

    if (editing) tr.classList.add("editing-row");

    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${escAttr(r.vence||"")}</th>
        <td>${r.proveedor||""}</td>
        <td>${r.concepto||""}</td>
        <td>${money(r.monto||0)}</td>
        <td><span class="badge ${badgeClass}">${overdue ? "Vencido" : (r.estado||"")}</span></td>
        <td class="note-cell">${noteHtml(r.notas)}</td>
        <td class="actions-cell">
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar CxP ${escAttr(r.concepto||"")} de ${escAttr(r.proveedor||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar CxP ${escAttr(r.concepto||"")} de ${escAttr(r.proveedor||"")}">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_cxp_vence_${r.id}" type="date" value="${escAttr(r.vence||"")}" /></td>
        <td><input id="ed_cxp_proveedor_${r.id}" value="${escAttr(r.proveedor||"")}" /></td>
        <td><input id="ed_cxp_concepto_${r.id}" value="${escAttr(r.concepto||"")}" /></td>
        <td><input id="ed_cxp_monto_${r.id}" type="number" min="0" step="1" value="${escAttr(r.monto ?? 0)}" /></td>
        <td>
          <select id="ed_cxp_estado_${r.id}">
            <option value="Pendiente" ${r.estado==="Pendiente" ? "selected" : ""}>Pendiente</option>
            <option value="Pagado" ${r.estado==="Pagado" ? "selected" : ""}>Pagado</option>
          </select>
        </td>
        <td><textarea id="ed_cxp_notas_${r.id}">${escAttr(r.notas||"")}</textarea></td>
        <td class="actions-cell">
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>`;
    }
    tbody.appendChild(tr);
  }
  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const id = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === "del") delRow("cxp", id);
    else if (act === "edit") editCxp(id);
    else if (act === "save") saveCxp(id);
    else if (act === "cancel") cancelEdit();
  };
}

function renderInventario(){
  const q = $("invSearch").value || "";
  const rows = (state.active.inventario||[])
    .filter(x=>textMatch(x,q))
    .sort((a,b)=>(a.categoria||"").localeCompare(b.categoria||"") || (a.producto||"").localeCompare(b.producto||""));

  $("invCount").textContent = String(rows.length);
  const tbody = $("invTbody");
  tbody.innerHTML="";
  for(const r of rows){
    const low = Number(r.stock||0) <= Number(r.minimo||0);
    const tr=document.createElement("tr");
    const editing = isEditing("inventario", r.id);
    if (!editing) {
      tr.innerHTML = `
        <th scope="row">${r.categoria||""}</th>
        <td>${r.producto||""}</td>
        <td>${Number(r.stock||0)}</td>
        <td>${Number(r.minimo||0)}</td>
        <td>${r.costo? money(r.costo): ""}</td>
        <td><span class="badge ${low?"due":"ok"}">${low?"Bajo stock":"OK"}</span></td>
        <td>
          <button class="ghost" data-act="edit" data-id="${r.id}" aria-label="Editar inventario ${escAttr(r.producto||"")} en ${escAttr(r.categoria||"")}">Editar</button>
          <button class="ghost danger" data-act="del" data-id="${r.id}" aria-label="Borrar inventario ${escAttr(r.producto||"")} en ${escAttr(r.categoria||"")}">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_inv_categoria_${r.id}" value="${escAttr(r.categoria||"")}" /></td>
        <td><input id="ed_inv_producto_${r.id}" value="${escAttr(r.producto||"")}" /></td>
        <td><input id="ed_inv_stock_${r.id}" type="number" min="0" step="1" value="${escAttr(r.stock ?? 0)}" /></td>
        <td><input id="ed_inv_minimo_${r.id}" type="number" min="0" step="1" value="${escAttr(r.minimo ?? 0)}" /></td>
        <td><input id="ed_inv_costo_${r.id}" type="number" min="0" step="0.01" value="${r.costo ?? ""}" /></td>
        <td><span class="badge ${low?"due":"ok"}">${low?"Bajo stock":"OK"}</span></td>
        <td>
          <button class="ghost" data-act="save" data-id="${r.id}">Guardar</button>
          <button class="ghost" data-act="cancel">Cancelar</button>
        </td>`;
    }
    tbody.appendChild(tr);
  }
  tbody.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    const { act, id } = btn.dataset;
    if (act === "del") delRow("inventario", id);
    else if (act === "edit") editInventario(id);
    else if (act === "save") saveInventario(id);
    else if (act === "cancel") cancelEdit();
  };
}

/* ---------- CRUD helpers ---------- */
function loadStore() {
  return JSON.parse(localStorage.getItem("xa_store_v1") || "{}");
}

function saveStore(store) {
  safeSetItem("xa_store_v1", store || {});
}

async function delRow(listName, id) {
  if (!confirm("¿Borrar este registro?")) return;

  const active = getActive();
  active[listName] ??= [];

  // borrar por id
  active[listName] = active[listName].filter(x => x.id !== id);

  // guardar y refrescar UI (esto recalcula el resumen)
  saveActiveData(active);
  state.active = active;
  renderAll();
}


function loadIngreso(id){
  const r=(state.active.ingresos||[]).find(x=>x.id===id); if(!r) return;
  $("inNombre").value=r.nombre||"";
  $("inFecha").value=r.fecha||todayISO();
  $("inConcepto").value=r.concepto||"";
  $("inMonto").value=r.monto||"";
  $("inMedio").value=r.medio||"Efectivo";
  $("inEstado").value=r.estado||"Pagado";
  $("inNotas").value=r.notas||"";
  $("addIngresoBtn").dataset.editId=id;
  $("addIngresoBtn").textContent="Actualizar ingreso";
}
function clearIngresoForm(){
  ["inNombre","inConcepto","inMonto","inNotas"].forEach(id=>$(id).value="");
  $("inFecha").value=todayISO();
  $("inMedio").value="Efectivo";
  $("inEstado").value="Pagado";
  delete $("addIngresoBtn").dataset.editId;
  $("addIngresoBtn").textContent="Guardar ingreso";
}
function loadGasto(id){
  const r = (state.active.gastos || []).find(x => x.id === id);
  if(!r) return;

  $("gaConcepto").value  = r.concepto || "";
  $("gaFecha").value     = r.fecha || "";        // 👈 no uses todayISO acá
  $("gaMonto").value     = String(r.monto ?? "");
  $("gaCategoria").value = r.categoria || "";
  $("gaNotas").value     = r.notas || "";

  $("addGastoBtn").dataset.editId = id;
$("addGastoBtn").textContent = "Actualizar egreso";

}

function clearGastoForm(){
  ["gaConcepto","gaMonto","gaCategoria","gaNotas"].forEach(id=>$(id).value="");
  $("gaFecha").value=todayISO();
  delete $("addGastoBtn").dataset.editId;
  $("addGastoBtn").textContent="Guardar egreso";
}
function loadCxc(id){
  const r=(state.active.cxc||[]).find(x=>x.id===id); if(!r) return;
  $("cxcnombre").value=r.nombre||"";
  $("cxcvence").value=r.vence||todayISO();
  $("cxcconcepto").value=r.concepto||"";
  $("cxcmonto").value=r.monto||"";
  $("cxcestado").value=r.estado||"Pendiente";
  $("cxcnotas").value=r.notas||"";
  $("addCxcBtn").dataset.editId=id;
  $("addCxcBtn").textContent="Actualizar";
}
function clearCxcForm(){
  ["cxcnombre","cxcconcepto","cxcmonto","cxcnotas"].forEach(id=>$(id).value="");
  $("cxcvence").value=todayISO();
  $("cxcestado").value="Pendiente";
  delete $("addCxcBtn").dataset.editId;
  $("addCxcBtn").textContent="Guardar";
}
function loadCxp(id){
  const r=(state.active.cxp||[]).find(x=>x.id===id); if(!r) return;
  $("cxpproveedor").value=r.proveedor||"";
  $("cxpvence").value=r.vence||todayISO();
  $("cxpconcepto").value=r.concepto||"";
  $("cxpmonto").value=r.monto||"";
  $("cxpestado").value=r.estado||"Pendiente";
  $("cxpnotas").value=r.notas||"";
  $("addCxpBtn").dataset.editId=id;
  $("addCxpBtn").textContent="Actualizar";
}
function clearCxpForm(){
  ["cxpproveedor","cxpconcepto","cxpmonto","cxpnotas"].forEach(id=>$(id).value="");
  $("cxpvence").value=todayISO();
  $("cxpestado").value="Pendiente";
  delete $("addCxpBtn").dataset.editId;
  $("addCxpBtn").textContent="Guardar";
}
function editCxp(id) {
  startEdit("cxp", id);
}
function saveCxp(id) {
  const proveedor = document.getElementById(`ed_cxp_proveedor_${id}`)?.value.trim() || "";
  const venceRaw  = document.getElementById(`ed_cxp_vence_${id}`)?.value || "";
  const concepto  = document.getElementById(`ed_cxp_concepto_${id}`)?.value.trim() || "";
  const montoStr  = document.getElementById(`ed_cxp_monto_${id}`)?.value || "0";
  const estado    = document.getElementById(`ed_cxp_estado_${id}`)?.value || "Pendiente";
  const notas     = document.getElementById(`ed_cxp_notas_${id}`)?.value || "";

  const vence = requireDateValue(venceRaw, "esta cuenta por pagar");
  if (!vence) return;
  const monto = requireMontoValue(montoStr, "esta cuenta por pagar");
  if (monto === null) return;
  if (!proveedor) return alert("El proveedor es obligatorio.");
  if (!concepto) return alert("El concepto no puede quedar vacío.");

  const active = getActive();
  active.cxp = (active.cxp || []).map(c =>
    c.id === id ? { ...c, proveedor, vence, concepto, monto, estado, notas } : c
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
}
window.editCxp = editCxp;
window.saveCxp = saveCxp;
function loadInv(id){
  const r=(state.active.inventario||[]).find(x=>x.id===id); if(!r) return;
  $("invCategoria").value=r.categoria||"";
  $("invProducto").value=r.producto||"";
  $("invStock").value=r.stock??"";
  $("invMin").value=r.minimo??"";
  $("invCosto").value=r.costo??"";
  $("saveInvBtn").dataset.editId=id;
  $("saveInvBtn").textContent="Actualizar";
}
function clearInvForm(){
  ["invCategoria","invProducto","invStock","invMin","invCosto"].forEach(id=>$(id).value="");
  delete $("saveInvBtn").dataset.editId;
  $("saveInvBtn").textContent="Guardar";
}
function editInventario(id) {
  startEdit("inventario", id);
}
function saveInventario(id) {
  const categoria = document.getElementById(`ed_inv_categoria_${id}`)?.value.trim() || "";
  const producto  = document.getElementById(`ed_inv_producto_${id}`)?.value.trim() || "";
  const stockStr  = document.getElementById(`ed_inv_stock_${id}`)?.value || "0";
  const minimoStr = document.getElementById(`ed_inv_minimo_${id}`)?.value || "0";
  const costoStr  = document.getElementById(`ed_inv_costo_${id}`)?.value ?? "";

  const stock = Number(stockStr);
  const minimo = Number(minimoStr);
  const costo = costoStr === "" ? null : Number(costoStr);

  if (!categoria || !producto) return alert("Poné categoría y producto.");
  if (Number.isNaN(stock) || stock < 0) return alert("El stock tiene que ser un número válido.");
  if (Number.isNaN(minimo) || minimo < 0) return alert("El mínimo tiene que ser un número válido.");
  if (costo !== null && (Number.isNaN(costo) || costo < 0)) return alert("El costo tiene que ser un número válido.");

  const active = getActive();
  active.inventario = (active.inventario || []).map(item =>
    item.id === id ? { ...item, categoria, producto, stock, minimo, costo } : item
  );

  setActive(active);
  persistActive(active);
  editMode = { section: null, id: null };
  render();
}
window.editInventario = editInventario;
window.saveInventario = saveInventario;
function markCxcPaid(id) {
  log.info("🔥 markCxcPaid ejecutándose", { id });

  const active = getActive();

  // asegurar arrays
  active.cxc ??= [];
  active.ingresos ??= [];

  const idx = active.cxc.findIndex(c => c.id === id);
  if (idx < 0) {
    log.warn("❌ No se encontró la CxC", { id });
    return;
  }

  // confirmación CORRECTA
  const ok = confirm("Marcar como pagado y crear ingreso automáticamente?");
  log.info("Confirmación de pago de CxC", { ok });
  if (!ok) return;

  // marcar como pagado
  active.cxc[idx].estado = "Pagado";
  active.cxc[idx].pagadoEn = todayISO();

  // crear ingreso automático
  active.ingresos.push({
    id: "ing_" + uid(),
    fecha: todayISO(),
    concepto: active.cxc[idx].concepto || "Cuota",
    nombre: active.cxc[idx].nombre || "",
    monto: Number(active.cxc[idx].monto || 0),
    medio: "Efectivo",
    estado: "Pagado",
    origen: "CXC",
    refId: active.cxc[idx].id
  });

  // persistir y refrescar UI
  saveActiveData(active);
  state.active = active;

  // refrescar todo
renderAll();

  log.info("✅ CxC marcada como pagada correctamente", { id });
}

window.markCxcPaid = markCxcPaid;



function renderResumen() {
  const active = getActive?.() || state?.active;
  if (!active) return;

  const ingresos = (active.ingresos || []).filter(i => (i.estado || "").toLowerCase() === "pagado");
  const egresos  = (active.egresos  || []).filter(e => (e.estado || "pagado").toLowerCase() === "pagado");

  const totalIngresos = ingresos.reduce((a, i) => a + Number(i.monto || 0), 0);
  const totalEgresos  = egresos.reduce((a, e) => a + Number(e.monto || 0), 0);
  const balance = totalIngresos - totalEgresos;

  // Intento de actualizar elementos comunes (si existen)
  const setMoney = (sel, val) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = "$ " + val.toLocaleString("es-UY");
  };

  setMoney("#kpiIngresos", totalIngresos);
  setMoney("#kpiEgresos", totalEgresos);
  setMoney("#kpiBalance", balance);


  // Por si tus IDs son otros, también prueba por data-attrs comunes:
  setMoney('[data-kpi="ingresos"]', totalIngresos);
  setMoney('[data-kpi="egresos"]', totalEgresos);
  setMoney('[data-kpi="balance"]', balance);
}

window.renderResumen = renderResumen;

/* ---------- Actions / Events ---------- */
function wireActions(){
    try {
  // Global filters
  $("monthFilter").addEventListener("change",(e)=>{
    state.filters.month = e.target.value || monthISO();
    renderDashboard();
  });
  $("searchAll").addEventListener("input",(e)=>{
    state.filters.search = e.target.value || "";
    renderDashboard();
  });

  // Searches
  $("ingSearch").addEventListener("input", renderIngresos);
  $("gasSearch").addEventListener("input", renderGastos);
  $("cxcSearch").addEventListener("input", rendercxc);
  $("cxpSearch").addEventListener("input", renderCxp);
  $("invSearch").addEventListener("input", renderInventario);

  // Add / update
  $("addIngresoBtn").addEventListener("click", async()=>{
    const fecha = requireDateValue($("inFecha").value, "este ingreso");
    const monto = requireMontoValue($("inMonto").value, "este ingreso");
    const nombre = $("inNombre").value.trim();
    const concepto = $("inConcepto").value.trim();
    if (!fecha || monto === null) return;
    if(!nombre || !concepto){ alert("Poné nombre y qué pagó."); return; }
    const data={
      id: $("addIngresoBtn").dataset.editId || uid(),
      nombre,
      fecha,
      concepto,
      monto,
      medio: $("inMedio").value,
      estado: $("inEstado").value,
      notas: $("inNotas").value.trim()
    };
    upsert("ingresos", data, $("addIngresoBtn").dataset.editId);
    await persistActive(); clearIngresoForm(); renderAll();
  });
  $("clearIngresoBtn").addEventListener("click", clearIngresoForm);

  $("addGastoBtn").addEventListener("click", async () => {
  const concepto  = $("gaConcepto").value.trim();
  const fechaIn   = $("gaFecha").value.trim();     // 👈 no default acá
  const monto     = requireMontoValue($("gaMonto").value, "este egreso");
  const categoria = $("gaCategoria").value.trim();
  const notas     = $("gaNotas").value.trim();
  if (monto === null) return;
  if (!concepto) return alert("Poné qué pagaste.");

  const btn = $("addGastoBtn");
  const editId = btn.dataset.editId || null;

  const active = getActive();
  active.gastos ??= [];
  const prev = editId ? active.gastos.find(g => g.id === editId) : null;
  const fechaValid = fechaIn ? requireDateValue(fechaIn, "este egreso") : (prev?.fecha || "");
  if (!fechaValid) return alert("Ingresá la fecha de este egreso.");

  if (editId) {
    // ✏️ EDITAR: mantener fecha previa si el input quedó vacío
    if (!prev) return alert("No encontré ese egreso para editar.");

    const updated = {
      ...prev,
      concepto,
      fecha: fechaValid || prev.fecha || todayISO(),
      monto,
      categoria,
      notas
    };

    active.gastos = active.gastos.map(g => (g.id === editId ? updated : g));

    // salir del modo edición
    delete btn.dataset.editId;
    btn.textContent = "Agregar egreso";

  } else {
    // ➕ NUEVO
    const item = {
      id: uid(),
      concepto,
      fecha: fechaValid || todayISO(),
      monto,
      categoria,
      notas
    };

    active.gastos.push(item);
  }

  setActive(active);
  state.active = active;
  await persistActive(active);

  clearGastoForm();
  renderAll();
});



const btnClearGasto = $("clearGastoBtn");
if (btnClearGasto) btnClearGasto.addEventListener("click", clearGastoForm);


const btnClearCxc = $("clearCxcBtn");
if (btnClearCxc) btnClearCxc.addEventListener("click", clearCxcForm);

const btnAddCxc = $("addCxcBtn");
if (btnAddCxc) btnAddCxc.addEventListener("click", async () => {
  const monto = requireMontoValue($("cxcmonto").value, "esta cuenta por cobrar");
  const vence = requireDateValue($("cxcvence").value, "esta cuenta por cobrar");
  const data = {
    id: btnAddCxc.dataset.editId || uid(),
    nombre: $("cxcnombre").value.trim(),
    vence,
    concepto: $("cxcconcepto").value.trim(),
    monto,
    estado: $("cxcestado").value || "Pendiente",
    notas: $("cxcnotas").value.trim()
  };

  if (!vence || monto === null) return;
  if (!data.nombre) { alert("Poné el alumno/cliente."); return; }
  if (!data.concepto) { alert("Poné el concepto."); return; }

  upsert("cxc", data, btnAddCxc.dataset.editId);
  await persistActive();
  clearCxcForm();
  renderAll();
});

const btnAddCxp = $("addCxpBtn");
if (btnAddCxp) btnAddCxp.addEventListener("click", async()=>{ 
    const monto = requireMontoValue($("cxpmonto").value, "esta cuenta por pagar");
    const vence = requireDateValue($("cxpvence").value, "esta cuenta por pagar");
    if (monto === null || !vence) return;

    const data={
      id: $("addCxpBtn").dataset.editId || uid(),
      proveedor: $("cxpproveedor").value.trim(),
      vence,
      concepto: $("cxpconcepto").value.trim(),
      monto,
      estado: $("cxpestado").value,
      notas: $("cxpnotas").value.trim()
    };
    if(!data.proveedor){ alert("Poné el proveedor."); return; }
    if(!data.concepto){ alert("Poné el concepto."); return; }
    upsert("cxp", data, $("addCxpBtn").dataset.editId);
    await persistActive(); clearCxpForm(); renderAll();
  });
  $("clearCxpBtn").addEventListener("click", clearCxpForm);

  $("saveInvBtn").addEventListener("click", async()=>{
    const data={
      id: $("saveInvBtn").dataset.editId || uid(),
      categoria: $("invCategoria").value.trim(),
      producto: $("invProducto").value.trim(),
      stock: Number($("invStock").value||0),
      minimo: Number($("invMin").value||0),
      costo: $("invCosto").value ? Number($("invCosto").value) : null
    };
    if(!data.categoria || !data.producto){ alert("Poné categoría y producto."); return; }
    upsert("inventario", data, $("saveInvBtn").dataset.editId);
    await persistActive(); clearInvForm(); renderAll();
  });
  $("clearInvBtn").addEventListener("click", clearInvForm);

  // Plantillas
  $("createTplBtn").addEventListener("click", async()=>{
    const name = $("tplName").value.trim() || monthISO();
    if(state.templates.some(t=>t.name===name)){ alert("Ya existe una plantilla con ese nombre."); return; }
    const t=emptyTemplate(name);
    await dbPut("templates", t);
    state.templates = sortTemplates(await dbGetAll("templates"));
    setActiveTemplate(t.id);
    $("tplName").value="";
    refreshTemplateSelectors();
  });
  $("cloneTplBtn").addEventListener("click", async () => {
  const fromId = $("tplCloneFrom").value;
  const name = $("tplName").value.trim() || monthISO();

  if (!fromId) { alert("Elegí una plantilla para copiar."); return; }
  if (state.templates.some(t => t.name === name)) { alert("Ya existe ese nombre."); return; }

  // 1) crear nueva plantilla (solo meta) en IndexedDB
  const newTpl = emptyTemplate(name);
  await dbPut("templates", newTpl);

  // 2) leer datos reales de la plantilla origen (desde xa_store_v1 usando el ID)
  setActiveId(fromId);
  const baseData = getActive();

  // 3) armar data del nuevo mes
  const monthData = {
    alumnos: (baseData.alumnos || []).map(a => ({ ...a })),          // copiamos alumnos
    inventario: (baseData.inventario || []).map(i => ({ ...i })),   // opcional (dejalo si querés)
    ingresos: [],
    gastos: [],
    pagos: [],
    asistencia: [],
    cxc: [],
    cxp: [] // si querés arrancar el mes con cxp vacío, dejalo así
  };

  // 4) generar CxC nuevas para TODOS los alumnos
  for (const a of monthData.alumnos) {
    addCuotaPendiente(monthData, a);
  }

  // 5) guardar data del nuevo mes en xa_store_v1 bajo el id de la NUEVA plantilla
  setActiveId(newTpl.id);
  saveActiveData(monthData);

  // 6) recargar lista de plantillas y activar la nueva
  state.templates = sortTemplates(await dbGetAll("templates"));
  refreshTemplateSelectors();
  setActiveTemplate(newTpl.id);

  $("tplName").value = "";
});


  $("tplActive").addEventListener("change",(e)=>setActiveTemplate(e.target.value));

  $("deleteTplBtn").addEventListener("click", async()=>{
    if(state.templates.length<=1){ alert("Tenés que dejar al menos una plantilla."); return; }
    const activeId = state.activeTemplateId;
    const tplMeta = state.templates.find(t => t.id === activeId) || state.active;
    const tplName = tplMeta?.name || "esta plantilla";

    if(!confirm(`¿Borrar la plantilla "${tplName}"? (No se puede deshacer)`)) return;

    await dbDelete("templates", activeId);

    // limpiar datos locales asociados en localStorage
    const store = xaLoad();
    if (store && Object.prototype.hasOwnProperty.call(store, activeId)) {
      delete store[activeId];
      xaSave(store);
    }

    state.templates = sortTemplates(await dbGetAll("templates"));
    const next = state.templates[state.templates.length-1];
    if (next) setActiveTemplate(next.id);
  });

  // Export/Import backups
  $("exportBackupBtn").addEventListener("click", exportBackup);
  $("importBackupBtn").addEventListener("click", ()=> $("filePicker").click());
  $("filePicker").addEventListener("change", importBackup);

  // CSV exports
  const b1 = $("exportIngresosCsvBtn"); if (b1) b1.addEventListener("click", () => exportCSV("ingresos"));
const b2 = $("exportGastosCsvBtn");   if (b2) b2.addEventListener("click", () => exportCSV("gastos"));
const b3 = $("exportCxcCsvBtn");      if (b3) b3.addEventListener("click", () => exportCSV("cxc"));
const b4 = $("exportCxpCsvBtn");      if (b4) b4.addEventListener("click", () => exportCSV("cxp"));
const b5 = $("exportInvCsvBtn");      if (b5) b5.addEventListener("click", () => exportCSV("inventario"));
const b6 = $("exportCsvAllBtn");      if (b6) b6.addEventListener("click", exportAllZip);

  // ===== ALUMNOS =====
const btnAddA = $("addAlumnoBtn");
if (btnAddA) btnAddA.addEventListener("click", addOrUpdateAlumno);

const btnClrA = $("clearAlumnoBtn");
if (btnClrA) btnClrA.addEventListener("click", clearAlumnoForm);

const sA = $("alSearch");
if (sA) sA.addEventListener("input", renderAlumnos);

const nac = $("alNacimiento");
if (nac) {
  nac.addEventListener("change", ()=>{
    const edad = $("alEdad");
    if (edad) edad.value = calcAge(nac.value);
  });
}
    } catch (err) {
    log.error("wireActions error:", err);
    alert("Error interno en la app. Revisá consola.");
  }
}

function upsert(listName, data, editId){
  const arr = state.active[listName]||[];
  if(editId){
    const i=arr.findIndex(x=>x.id===editId);
    if(i>=0) arr[i]=data;
  }else{
    arr.push(data);
  }
  state.active[listName]=arr;
}

function refreshTemplateSelectors(){
  const activeSel = $("tplActive");
  const cloneSel = $("tplCloneFrom");
  activeSel.innerHTML=""; cloneSel.innerHTML="";
  for(const t of state.templates){
    const o1=document.createElement("option");
    o1.value=t.id; o1.textContent=t.name;
    if(t.id===state.activeTemplateId) o1.selected=true;
    activeSel.appendChild(o1);

    const o2=document.createElement("option");
    o2.value=t.id; o2.textContent=t.name;
    if(t.id===state.activeTemplateId) o2.selected=true;
    cloneSel.appendChild(o2);
  }
}

/* ---------- Backup & Export ---------- */
function exportBackup(){
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    templates: state.templates
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
  download(`xtreme-backup-${monthISO()}.json`, blob);
}

async function importBackup(e){
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  try{
    const txt = await file.text();
    const payload = JSON.parse(txt);
    if(!payload.templates || !Array.isArray(payload.templates)) throw new Error("Formato inválido");

    const version = Number(payload.version || 0);
    if (version && version !== 1) {
      const ok = confirm(`El respaldo es de versión ${version} y la app espera v1. ¿Intentar importarlo igual?`);
      if (!ok) return;
    }

    const summaryLines = payload.templates.map(t => {
      const name = t.name || "(sin nombre)";
      const ing = (t.ingresos||[]).length;
      const gas = (t.gastos||[]).length;
      const cxc = (t.cxc||[]).length;
      const cxp = (t.cxp||[]).length;
      const inv = (t.inventario||[]).length;
      const alumnos = (t.alumnos||[]).length;
      return `- ${name} (ing:${ing} gas:${gas} cxc:${cxc} cxp:${cxp} inv:${inv} alumnos:${alumnos})`;
    }).join("\n");

    const filterName = prompt(
      `Plantillas encontradas (${payload.templates.length}):\n${summaryLines}\n\nEscribí el nombre que querés importar o dejá vacío para importar todas.`
    )?.trim();

    const selected = filterName
      ? payload.templates.filter(t => String(t.name || "").trim() === filterName)
      : payload.templates;

    if (filterName && selected.length === 0) {
      alert("No encontré esa plantilla en el respaldo.");
      return;
    }

    if(!confirm(`¿Importar ${selected.length} plantilla(s)? Esto reemplaza/mezcla plantillas existentes por nombre.`)) return;

    // Merge by name (unique)
    const existing = await dbGetAll("templates");
    const byName = new Map(existing.map(t=>[t.name,t]));
    for(const t of selected){
      // Normalize
      if(!t.id) t.id=uid();
      t.updatedAt=Date.now();
      byName.set(t.name, t);
    }
    for(const t of byName.values()){
      await dbPut("templates", t);
    }
    state.templates = sortTemplates(await dbGetAll("templates"));
    // Keep current active if possible
    const still = state.templates.find(t=>t.id===state.activeTemplateId) || state.templates[state.templates.length-1];
    setActiveTemplate(still.id);
    alert("Respaldo importado.");
  }catch(err){
    alert("No pude importar: " + (err.message||err));
  }finally{
    e.target.value="";
  }
}

function exportCSV(listName){
  const t = state.active;
  const rows = (t[listName]||[]);
  let headers=[];
  if(listName==="ingresos") headers=["fecha","nombre","concepto","monto","medio","estado","notas"];
  if(listName==="gastos") headers=["fecha","concepto","categoria","monto","notas"];
  if(listName==="cxc") headers=["vence","nombre","concepto","monto","estado","notas"];
  if(listName==="cxp") headers=["vence","proveedor","concepto","monto","estado","notas"];
  if(listName==="inventario") headers=["categoria","producto","stock","minimo","costo"];
  const csv = toCSV(rows, headers);
  download(`xtreme-${t.name}-${listName}.csv`, new Blob([csv],{type:"text/csv"}));
}

async function exportAllZip(){
  // Build a zip in-browser using CompressionStream if available; fallback to multiple downloads.
  const t = state.active;
  const files = [
    {name:`ingresos.csv`, data: toCSV(t.ingresos||[], ["fecha","nombre","concepto","monto","medio","estado","notas"])},
    {name:`egresos.csv`, data: toCSV(t.gastos||[], ["fecha","concepto","categoria","monto","notas"])},
    {name:`cxc.csv`, data: toCSV(t.cxc||[], ["vence","nombre","concepto","monto","estado","notas"])},
    {name:`cxp.csv`, data: toCSV(t.cxp||[], ["vence","proveedor","concepto","monto","estado","notas"])},
    {name:`inventario.csv`, data: toCSV(t.inventario||[], ["categoria","producto","stock","minimo","costo"])},
  ];
  // Minimal ZIP (store) builder
  const enc = new TextEncoder();
  const chunks=[];
  let offset=0;
  const central=[];
  function u16(n){ return new Uint8Array([n&255,(n>>8)&255]); }
  function u32(n){ return new Uint8Array([n&255,(n>>8)&255,(n>>16)&255,(n>>24)&255]); }
  function crc32(buf){
    let c=~0; for(let i=0;i<buf.length;i++){ c=(c>>>8) ^ table[(c ^ buf[i]) & 0xff]; } return ~c>>>0;
  }
  // CRC table
  const table = (()=>{ let t=new Uint32Array(256); for(let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[i]=c>>>0; } return t; })();

  for(const f of files){
    const data = enc.encode(f.data);
    const crc = crc32(data);
    const nameBytes = enc.encode(f.name);

    // Local file header
    const lf = [];
    lf.push(u32(0x04034b50)); // signature
    lf.push(u16(20)); // version
    lf.push(u16(0)); // flags
    lf.push(u16(0)); // method store
    lf.push(u16(0)); // time
    lf.push(u16(0)); // date
    lf.push(u32(crc));
    lf.push(u32(data.length));
    lf.push(u32(data.length));
    lf.push(u16(nameBytes.length));
    lf.push(u16(0)); // extra
    const header = concat(lf);
    chunks.push(header, nameBytes, data);

    // Central directory header
    const cd=[];
    cd.push(u32(0x02014b50));
    cd.push(u16(20)); // made by
    cd.push(u16(20)); // version needed
    cd.push(u16(0));  // flags
    cd.push(u16(0));  // method
    cd.push(u16(0)); cd.push(u16(0)); // time/date
    cd.push(u32(crc));
    cd.push(u32(data.length));
    cd.push(u32(data.length));
    cd.push(u16(nameBytes.length));
    cd.push(u16(0)); // extra
    cd.push(u16(0)); // comment
    cd.push(u16(0)); // disk
    cd.push(u16(0)); // int attr
    cd.push(u32(0)); // ext attr
    cd.push(u32(offset));
    const cdrec = concat(cd);
    central.push(cdrec, nameBytes);

    offset += header.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralBlob = concat(central);
  offset += centralBlob.length;

  const eocd = concat([
    u32(0x06054b50),
    u16(0),u16(0),
    u16(files.length),u16(files.length),
    u32(centralBlob.length),
    u32(centralStart),
    u16(0)
  ]);

  const zipBlob = new Blob([...chunks, centralBlob, eocd], {type:"application/zip"});
  download(`xtreme-${t.name}-csv.zip`, zipBlob);

  function concat(arr){
    // arr: (Uint8Array)[]
    const total = arr.reduce((a,b)=>a+b.length,0);
    const out = new Uint8Array(total);
    let p=0;
    for(const a of arr){ out.set(a,p); p+=a.length; }
    return out;
  }
}

/* ---------- Start ---------- */
init();

/* ========= ALUMNOS ========= */

function calcAge(birthISO){
  if(!birthISO) return "";
  const b = new Date(birthISO + "T00:00:00");
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
  return age < 0 ? "" : age;
}

function isEditing(section, id) {
  return editMode.section === section && editMode.id === id;
}

function startEdit(section, id) {
  editMode = { section, id };
  render();
}

function cancelEdit() {
  editMode = { section: null, id: null };
  render();
}

function setupInlineEditHotkeys() {
  const saveHandlers = {
    ingresos: saveIngreso,
    gastos: saveGasto,
    cxc: saveCxc,
    cxp: saveCxp,
    inventario: saveInventario,
    alumnos: saveAlumno
  };

  document.addEventListener("keydown", (event) => {
    if (!editMode.section || !editMode.id) return;
    if (!event.target || typeof event.target.closest !== "function") return;

    const editingRow = event.target.closest(".editing-row");
    if (!editingRow) return;

    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }

    if (event.key === "Enter") {
      const tag = String(event.target.tagName || "").toLowerCase();
      if (tag === "textarea" && !(event.ctrlKey || event.metaKey)) return;

      const handler = saveHandlers[editMode.section];
      if (typeof handler === "function") {
        event.preventDefault();
        handler(editMode.id);
      }
    }
  });
}

// Tu botón actual llama editAlumno(id)
// Para no romper HTML con comillas, etc.
function escAttr(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function saveAlumno(id) {
  const nombre     = document.getElementById(`ed_nombre_${id}`)?.value.trim() || "";
  const nacimiento = document.getElementById(`ed_nacimiento_${id}`)?.value || "";
  const numero     = document.getElementById(`ed_numero_${id}`)?.value.trim() || "";
  const ingreso    = document.getElementById(`ed_ingreso_${id}`)?.value || "";
  const programa   = document.getElementById(`ed_programa_${id}`)?.value.trim() || "";
  const cuotaStr   = document.getElementById(`ed_cuota_${id}`)?.value || "0";
  const ata         = document.getElementById(`ed_at_${id}`)?.value.trim() || "";

  const cuota = requireMontoValue(cuotaStr, "la cuota del alumno");
  if (cuota === null) return;
  if (!nombre) return alert("El nombre no puede quedar vacío.");

  const active = getActive();
  const arr = active.alumnos || [];

  active.alumnos = arr.map(a => {
    if (a.id !== id) return a;
    return { ...a, nombre, nacimiento, numero, ingreso, programa, cuota, ata };
  });

  // ⚠️ IMPORTANTE:
  
  setActive(active);

  editMode = { section: null, id: null };
  render();
}

// Si usás onclick="..." en HTML, esto asegura que existan
window.editAlumno = editAlumno;
window.saveAlumno = saveAlumno;
window.cancelEdit = cancelEdit;


function renderAlumnos(){
  if(!$("alTbody")) return;

  const q = $("alSearch").value || "";
  const rows = (getActive().alumnos || [])
    .filter(x => textMatch(x, q))
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));

  $("alCount").textContent = rows.length;
  $("alTbody").innerHTML = "";

  rows.forEach(a=>{
    const tr = document.createElement("tr");
    const editing = (editMode.section === "alumnos" && editMode.id === a.id);

    if (!editing) {
      tr.innerHTML = `
        <td>${escAttr(a.nombre)}</td>
        <td>${escAttr(a.nacimiento||"")}</td>
        <td>${escAttr(calcAge(a.nacimiento))}</td>
        <td>${escAttr(a.numero||"")}</td>
        <td>${escAttr(a.ingreso||"")}</td>
        <td>${escAttr(a.programa||"")}</td>
        <td>${money(a.cuota||0)}</td>
        <td>${escAttr(a.ata||"")}</td>
        <td>
          <button class="ghost" onclick="editAlumno('${a.id}')">Editar</button>
          <button class="ghost danger" onclick="deleteAlumno('${a.id}')">Borrar</button>
        </td>`;
    } else {
      tr.innerHTML = `
        <td><input id="ed_nombre_${a.id}" value="${escAttr(a.nombre)}" /></td>
        <td><input id="ed_nacimiento_${a.id}" type="date" value="${escAttr(a.nacimiento||"")}" /></td>
        <td>${escAttr(calcAge(a.nacimiento))}</td>
        <td><input id="ed_numero_${a.id}" value="${escAttr(a.numero||"")}" /></td>
        <td><input id="ed_ingreso_${a.id}" type="date" value="${escAttr(a.ingreso||"")}" /></td>
        <td><input id="ed_programa_${a.id}" value="${escAttr(a.programa||"")}" /></td>
        <td><input id="ed_cuota_${a.id}" type="number" min="0" step="1" value="${escAttr(a.cuota ?? 0)}" /></td>
        <td><input id="ed_at_${a.id}" value="${escAttr(a.ata||"")}" /></td>
        <td>
          <button class="ghost" onclick="saveAlumno('${a.id}')">Guardar</button>
          <button class="ghost" onclick="cancelEdit()">Cancelar</button>
        </td>`;
    }

    $("alTbody").appendChild(tr);
  });
}

function addOrUpdateAlumno(){
  const active = getActive();
  const id = $("addAlumnoBtn").dataset.editId || uid();
  const cuota = requireMontoValue($("alCuota").value, "la cuota del alumno");
  if (cuota === null) return;

  const alumno = {
    id,
    nombre: $("alNombre").value.trim(),
    nacimiento: $("alNacimiento").value,
    numero: $("alNumero").value,
    ingreso: $("alIngreso").value || todayISO(),
    programa: $("alPrograma").value,
    cuota,
    ata: $("alAta").value
  };

  if(!alumno.nombre){
    alert("El nombre es obligatorio");
    return;
  }

 const idx = active.alumnos.findIndex(a => a.id === id);
// ... donde ya guardás alumno ...
if (idx >= 0) active.alumnos[idx] = alumno;
else active.alumnos.push(alumno);

addCuotaPendiente(active, alumno);


log.info("CxC en memoria (active.cxc)", { cantidad: active.cxc?.length });

saveActiveData(active);

const fresh = getActive();
log.info("CxC leída desde getActive()", { cantidad: fresh.cxc ? fresh.cxc.length : 0 });

state.active = active;

const cxcSearch = $("cxcSearch");
if (cxcSearch) cxcSearch.value = "";

if (typeof rendercxc === "function") rendercxc();
if (typeof renderResumen === "function") renderResumen();

clearAlumnoForm();
renderAlumnos();


}

function editAlumno(id){
  const a = getActive().alumnos.find(x=>x.id===id);
  if(!a) return;

  $("alNombre").value = a.nombre;
  $("alNacimiento").value = a.nacimiento;
  $("alEdad").value = calcAge(a.nacimiento);
  $("alNumero").value = a.numero;
  $("alIngreso").value = a.ingreso;
  $("alPrograma").value = a.programa;
  $("alCuota").value = a.cuota;
  $("alAta").value = a.ata;

  $("addAlumnoBtn").dataset.editId = id;
  $("addAlumnoBtn").textContent = "Actualizar alumno";
}

const deleteAlumnoImpl = (id) => {
  if(!confirm("¿Borrar alumno? Esto también elimina sus cuentas por cobrar.")) return;

  const active = getActive?.() || state?.active;
  if (!active) return;

  const alumnoId = String(id).trim();
  const alumno = (active.alumnos || []).find(a => String(a.id).trim() === alumnoId);

  const nombre = String(alumno?.nombre || "").trim().toLowerCase();
  const numero = String(alumno?.numero || "").trim();
  const ata    = String(alumno?.ata || "").trim();

  // 1) borrar alumno
  active.alumnos = (active.alumnos || []).filter(a => String(a.id).trim() !== alumnoId);

  // 2) borrar CxC asociadas (probamos varios campos comunes)
  const before = (active.cxc || []).length;

  active.cxc = (active.cxc || []).filter(c => {
    const cNombre = String(c.nombre || c.cliente || c.alumno || "").trim().toLowerCase();
    const cAlumnoId = String(c.alumnoId || c.clienteId || c.refAlumnoId || "").trim();
    const cNumero = String(c.numero || c.doc || "").trim();
    const cAta    = String(c.ata || "").trim();

    const matchById = cAlumnoId && cAlumnoId === alumnoId;
    const matchByNombre = nombre && cNombre === nombre;
    const matchByNumero = numero && cNumero === numero;
    const matchByAta = ata && cAta === ata;

    // si matchea por cualquiera → se elimina (o sea, NO se conserva)
    return !(matchById || matchByNombre || matchByNumero || matchByAta);
  });

  const after = (active.cxc || []).length;
  log.info("CxC borradas junto con alumno", { eliminadas: before - after });

  saveActiveData(active);
  state.active = active;

  if (typeof renderAlumnos === "function") renderAlumnos();
  if (typeof rendercxc === "function") rendercxc();
  if (typeof renderResumen === "function") renderResumen();
};
window.deleteAlumno = deleteAlumnoImpl;





function clearAlumnoForm(){
  ["alNombre","alNacimiento","alEdad","alNumero","alCuota","alAta"]
    .forEach(id => $(id).value = "");

  $("alIngreso").value = todayISO();
  $("alPrograma").value = "BASICO";
  $("addAlumnoBtn").textContent = "Guardar alumno";
  delete $("addAlumnoBtn").dataset.editId;
}
  
