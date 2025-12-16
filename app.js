/** Xtreme Academy - Cuentas (PWA)
 *  - Guardado local en IndexedDB
 *  - Plantillas (meses) con tablas: ingresos, gastos, cxc, cxp, inventario
 */
const $ = (id)=>document.getElementById(id);
// 🔎 DEBUG: mostrar errores en pantalla (iPhone friendly)
window.addEventListener("error", (e) => {
  alert("JS ERROR: " + (e.message || e.type) + "\n" + (e.filename || "") + ":" + (e.lineno || ""));
});
window.addEventListener("unhandledrejection", (e) => {
  alert("PROMISE ERROR: " + (e.reason?.message || e.reason || "unknown"));
});
const money = (n)=> new Intl.NumberFormat("es-UY",{style:"currency",currency:"UYU",maximumFractionDigits:0}).format(Number(n||0));
const todayISO = ()=> new Date().toISOString().slice(0,10);
const monthISO = (d)=> (d||new Date()).toISOString().slice(0,7);
const uid = ()=> (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random().toString(16).slice(2));

// ===== Active data (GLOBAL) =====
const XA_STORE_KEY = "xa_store_v1";
const XA_ACTIVE_KEY = "xa_active_v1";

function xaLoad() {
  try { return JSON.parse(localStorage.getItem(XA_STORE_KEY)) || {}; }
  catch { return {}; }
}

function xaSave(store) {
  localStorage.setItem(XA_STORE_KEY, JSON.stringify(store || {}));
}

function getActiveId() {
  return localStorage.getItem(XA_ACTIVE_KEY) || "default";
}

function setActiveId(id) {
  localStorage.setItem(XA_ACTIVE_KEY, id);
}

function getActive() {
  const store = xaLoad();
  const id = getActiveId();

  store[id] ??= {
  alumnos: [],
  pagos: [],
  gastos: [],
  asistencia: [],
  cxc: []            
};


store[id].cxc ??= [];

xaSave(store);
return store[id];
}

function ensureCxc(active){
  if (!Array.isArray(active.cxc)) active.cxc = [];
}

function addCuotaPendiente(active, alumno){
  ensureCxc(active);

  const periodo = monthISO();

  const existe = active.cxc.some(c =>
    c.alumnoId === alumno.id &&
    c.periodo === periodo &&
    c.estado === "pendiente"
  );

  if (existe) return;

  active.cxc.push({
    id: "cxc_" + uid(),
    alumnoId: alumno.id,
    nombre: alumno.nombre,
    programa: alumno.programa,
    monto: Number(alumno.cuota || 0),
    periodo,
    concepto: "Cuota mensual",
    estado: "Pendiente",
    createdAt: todayISO()
  });
}

/* ---------- IndexedDB minimal wrapper ---------- */
const DB_NAME = "xtremeCuentasDB";
const DB_VER = 1;

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = ()=>{
      const db=req.result;
      const templates=db.createObjectStore("templates",{keyPath:"id"});
      templates.createIndex("byName","name",{unique:true});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
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
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error);
    tx.objectStore(store).put(value);
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
  ["inFecha","gaFecha","cxcvence","cxpvence"].forEach(id=>{ if($(id)) $(id).value=todayISO(); });
  $("monthFilter").value = state.filters.month;

  // Load templates
  const templates = await dbGetAll("templates");
  state.templates = templates.sort((a,b)=>a.name.localeCompare(b.name));

  // Create first template if none
  if(state.templates.length===0){
    const name = monthISO();
    const t=emptyTemplate(name);
    await dbPut("templates", t);
    state.templates=[t];
  }

  // Determine active template (stored in localStorage)
  const savedActive = localStorage.getItem("xt_active_template");
  const active = state.templates.find(t=>t.id===savedActive) || state.templates[state.templates.length-1];
  state.activeTemplateId = active.id;
  state.active = active;

  // UI wiring
  wireTabs();
  wireActions();

  // Render
  refreshTemplateSelectors();
  renderAll();

  // PWA registration
  // if ("serviceWorker" in navigator) {
//   navigator.serviceWorker.register("./sw.js");
// }
}

function saveActive(){
  localStorage.setItem("xt_active_template", state.activeTemplateId);
}

function saveActiveData(active) {
  const store = xaLoad();
  const id = getActiveId();
  store[id] = active;
  xaSave(store);
}

function setActiveTemplate(id){
  const t = state.templates.find(x=>x.id===id);
  if(!t) return;
  state.activeTemplateId=id;
  state.active=t;
  saveActive();
  renderAll();
}

/* ---------- Tabs ---------- */
function wireTabs(){
  document.querySelectorAll(".nav button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".nav button").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const tab=btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(s=>s.hidden=true);
      $("tab-"+tab).hidden=false;
    });
  });
}

/* ---------- Helpers ---------- */
function persistActive(){
  state.active.updatedAt=Date.now();
  return dbPut("templates", state.active).then(async()=>{
    // reload list (keeps ordering)
    state.templates = (await dbGetAll("templates")).sort((a,b)=>a.name.localeCompare(b.name));
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

function csvEscape(v){
  const s = (v===null||v===undefined) ? "" : String(v);
  if(/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

function download(filename, blob){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();}, 2000);
}

function toCSV(rows, headers){
  const head = headers.map(csvEscape).join(",") + "\n";
  const body = rows.map(r=>headers.map(h=>csvEscape(r[h])).join(",")).join("\n");
  return head + body + "\n";
}

/* ---------- Rendering ---------- */
function renderAll(){
  $("activeTemplateLabel").textContent = "Plantilla: " + state.active.name;
  $("monthFilter").value = state.filters.month;

  renderDashboard();
  renderIngresos();
  renderGastos();
  renderCxc();
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
}

function renderIngresos(){
  const q = $("ingSearch").value || "";
  const rows = (state.active.ingresos||[])
    .filter(x=>textMatch(x,q))
    .sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));

  $("ingCount").textContent = String(rows.length);
  const tbody = $("ingTbody");
  tbody.innerHTML="";
  for(const r of rows){
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${r.fecha||""}</td>
      <td>${r.nombre||""}</td>
      <td>${r.concepto||""}</td>
      <td>${money(r.monto||0)}</td>
      <td>${r.medio||""}</td>
      <td><span class="badge ${r.estado==="Pagado"?"ok":""}">${r.estado||""}</span></td>
      <td>
        <button class="ghost" data-act="edit" data-id="${r.id}">Editar</button>
        <button class="ghost danger" data-act="del" data-id="${r.id}">Borrar</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", (e)=>{
      const id=b.dataset.id; const act=b.dataset.act;
      if(act==="del"){ delRow("ingresos", id); }
      if(act==="edit"){ loadIngreso(id); }
    });
  });
}

function renderGastos(){
  const q = $("gasSearch").value || "";
  const rows = (state.active.gastos||[])
    .filter(x=>textMatch(x,q))
    .sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));

  $("gasCount").textContent = String(rows.length);
  const tbody = $("gasTbody");
  tbody.innerHTML="";
  for(const r of rows){
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${r.fecha||""}</td>
      <td>${r.concepto||""}</td>
      <td>${r.categoria||""}</td>
      <td>${money(r.monto||0)}</td>
      <td>
        <button class="ghost" data-act="edit" data-id="${r.id}">Editar</button>
        <button class="ghost danger" data-act="del" data-id="${r.id}">Borrar</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const id=b.dataset.id; const act=b.dataset.act;
      if(act==="del"){ delRow("gastos", id); }
      if(act==="edit"){ loadGasto(id); }
    });
  });
}

function markCxcPaid(id){
  const active = getActive();
  const cxc = active.cxc.find(c => c.id === id);
  if (!cxc) return;

  cxc.estado = "Pagado";
  cxc.pagadoEn = todayISO();

  active.ingresos ??= [];
  active.ingresos.push({
    id: "ing_" + uid(),
    fecha: todayISO(),
    concepto: cxc.concepto || "Cuota",
    nombre: cxc.nombre,
    monto: cxc.monto,
    origen: "CXC",
    refId: cxc.id
  });

  saveActiveData(active);
  renderCxc();
  renderIngresos();
  renderResumen();
}


function renderCxc(){
  const q = $("cxcSearch").value || "";
  const rows = (getActive().cxc || [])
    .filter(x=>textMatch(x,q))
    .sort((a,b)=>(a.vence||"").localeCompare(b.vence||""));

  $("cxcCount").textContent = String(rows.length);
  const tbody = $("cxcTbody");
  tbody.innerHTML="";
  const now = todayISO();
  for(const r of rows){
    const overdue = r.estado!=="Pagado" && r.vence && r.vence < now;
    const badgeClass = r.estado==="Pagado" ? "ok" : (overdue ? "due" : "");
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${r.vence||""}</td>
      <td>${r.nombre||""}</td>
      <td>${r.concepto||""}</td>
      <td>${money(r.monto||0)}</td>
      <td><span class="badge ${badgeClass}">${overdue ? "Vencido" : (r.estado||"")}</span></td>
      <td>
        ${r.estado!=="Pagado" ? `<button class="ghost" data-act="pay" data-id="${r.id}">Marcar pagado</button>` : ""}
        <button class="ghost" data-act="edit" data-id="${r.id}">Editar</button>
        <button class="ghost danger" data-act="del" data-id="${r.id}">Borrar</button>
      </td>`;
    tbody.appendChild(tr);
  }
tbody.onclick = (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;

  const id = btn.dataset.id;
  const act = btn.dataset.act;

  console.log("CXC CLICK", act, id);

  if (act === "del")  delRow("cxc", id);
  if (act === "edit") loadCxc(id);
  if (act === "pay")  markCxcPaid(id);
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
    const overdue = r.estado!=="Pagado" && r.vence && r.vence < now;
    const badgeClass = r.estado==="Pagado" ? "ok" : (overdue ? "due" : "");
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${r.vence||""}</td>
      <td>${r.proveedor||""}</td>
      <td>${r.concepto||""}</td>
      <td>${money(r.monto||0)}</td>
      <td><span class="badge ${badgeClass}">${overdue ? "Vencido" : (r.estado||"")}</span></td>
      <td>
        <button class="ghost" data-act="edit" data-id="${r.id}">Editar</button>
        <button class="ghost danger" data-act="del" data-id="${r.id}">Borrar</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const id=b.dataset.id; const act=b.dataset.act;
      if(act==="del"){ delRow("cxp", id); }
      if(act==="edit"){ loadCxp(id); }
    });
  });
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
    tr.innerHTML = `
      <td>${r.categoria||""}</td>
      <td>${r.producto||""}</td>
      <td>${Number(r.stock||0)}</td>
      <td>${Number(r.minimo||0)}</td>
      <td>${r.costo? money(r.costo): ""}</td>
      <td><span class="badge ${low?"due":"ok"}">${low?"Bajo stock":"OK"}</span></td>
      <td>
        <button class="ghost" data-act="edit" data-id="${r.id}">Editar</button>
        <button class="ghost danger" data-act="del" data-id="${r.id}">Borrar</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>{
      const id=b.dataset.id; const act=b.dataset.act;
      if(act==="del"){ delRow("inventario", id); }
      if(act==="edit"){ loadInv(id); }
    });
  });
}

/* ---------- CRUD helpers ---------- */
async function delRow(listName, id){
  if(!confirm("¿Borrar este registro?")) return;
  state.active[listName] = (state.active[listName]||[]).filter(x=>x.id!==id);
  await persistActive();
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
  const r=(state.active.gastos||[]).find(x=>x.id===id); if(!r) return;
  $("gaConcepto").value=r.concepto||"";
  $("gaFecha").value=r.fecha||todayISO();
  $("gaMonto").value=r.monto||"";
  $("gaCategoria").value=r.categoria||"";
  $("gaNotas").value=r.notas||"";
  $("addGastoBtn").dataset.editId=id;
  $("addGastoBtn").textContent="Actualizar egreso";
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

async function markCxcPaid(id){
  const r=(state.active.cxc||[]).find(x=>x.id===id); if(!r) return;
  if(!confirm("¿Marcar como pagado y crear ingreso automáticamente?")) return;
  r.estado="Pagado";
  // Create ingreso
  const ingreso = {
    id: uid(),
    nombre: r.nombre || "",
    fecha: todayISO(),
    concepto: r.concepto || "CUOTA",
    monto: Number(r.monto||0),
    medio: "Efectivo",
    estado: "Pagado",
    notas: "Generado desde CxC"
  };
  state.active.ingresos.push(ingreso);
  await persistActive();
  renderAll();
}

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
  $("cxcSearch").addEventListener("input", renderCxc);
  $("cxpSearch").addEventListener("input", renderCxp);
  $("invSearch").addEventListener("input", renderInventario);

  // Add / update
  $("addIngresoBtn").addEventListener("click", async()=>{
    const data={
      id: $("addIngresoBtn").dataset.editId || uid(),
      nombre: $("inNombre").value.trim(),
      fecha: $("inFecha").value || todayISO(),
      concepto: $("inConcepto").value.trim(),
      monto: Number($("inMonto").value||0),
      medio: $("inMedio").value,
      estado: $("inEstado").value,
      notas: $("inNotas").value.trim()
    };
    if(!data.nombre || !data.concepto){ alert("Poné nombre y qué pagó."); return; }
    upsert("ingresos", data, $("addIngresoBtn").dataset.editId);
    await persistActive(); clearIngresoForm(); renderAll();
  });
  $("clearIngresoBtn").addEventListener("click", clearIngresoForm);

  $("addGastoBtn").addEventListener("click", async()=>{
    const data={
      id: $("addGastoBtn").dataset.editId || uid(),
      concepto: $("gaConcepto").value.trim(),
      fecha: $("gaFecha").value || todayISO(),
      monto: Number($("gaMonto").value||0),
      categoria: $("gaCategoria").value.trim(),
      notas: $("gaNotas").value.trim()
    };
    if(!data.concepto){ alert("Poné qué pagaste."); return; }
    upsert("gastos", data, $("addGastoBtn").dataset.editId);
    await persistActive(); clearGastoForm(); renderAll();
  });
  $("clearGastoBtn").addEventListener("click", clearGastoForm);

  $("addCxcBtn").addEventListener("click", async()=>{
    const data={
      id: $("addCxcBtn").dataset.editId || uid(),
      nombre: $("cxcnombre").value.trim(),
      vence: $("cxcvence").value || todayISO(),
      concepto: $("cxcconcepto").value.trim() || "CUOTA",
      monto: Number($("cxcmonto").value||0),
      estado: $("cxcestado").value,
      notas: $("cxcnotas").value.trim()
    };
    if(!data.nombre){ alert("Poné el nombre."); return; }
    upsert("cxc", data, $("addCxcBtn").dataset.editId);
    await persistActive(); clearCxcForm(); renderAll();
  });
  $("clearCxcBtn").addEventListener("click", clearCxcForm);

  $("addCxpBtn").addEventListener("click", async()=>{
    const data={
      id: $("addCxpBtn").dataset.editId || uid(),
      proveedor: $("cxpproveedor").value.trim(),
      vence: $("cxpvence").value || todayISO(),
      concepto: $("cxpconcepto").value.trim(),
      monto: Number($("cxpmonto").value||0),
      estado: $("cxpestado").value,
      notas: $("cxpnotas").value.trim()
    };
    if(!data.proveedor){ alert("Poné el proveedor."); return; }
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
    state.templates = (await dbGetAll("templates")).sort((a,b)=>a.name.localeCompare(b.name));
    setActiveTemplate(t.id);
    $("tplName").value="";
    refreshTemplateSelectors();
  });
  $("cloneTplBtn").addEventListener("click", async()=>{
    const fromId = $("tplCloneFrom").value;
    const base = state.templates.find(t=>t.id===fromId);
    const name = $("tplName").value.trim() || (monthISO()+" (copia)");
    if(!base){ alert("Elegí una plantilla para copiar."); return; }
    if(state.templates.some(t=>t.name===name)){ alert("Ya existe ese nombre."); return; }
    const t=cloneTemplate(base, name);
    await dbPut("templates", t);
    state.templates = (await dbGetAll("templates")).sort((a,b)=>a.name.localeCompare(b.name));
    setActiveTemplate(t.id);
    $("tplName").value="";
  });

  $("tplActive").addEventListener("change",(e)=>setActiveTemplate(e.target.value));

  $("deleteTplBtn").addEventListener("click", async()=>{
    if(state.templates.length<=1){ alert("Tenés que dejar al menos una plantilla."); return; }
    const t=state.active;
    if(!confirm(`¿Borrar la plantilla "${t.name}"? (No se puede deshacer)`)) return;
    await dbDelete("templates", t.id);
    state.templates = (await dbGetAll("templates")).sort((a,b)=>a.name.localeCompare(b.name));
    const next = state.templates[state.templates.length-1];
    setActiveTemplate(next.id);
  });

  // Export/Import backups
  $("exportBackupBtn").addEventListener("click", exportBackup);
  $("importBackupBtn").addEventListener("click", ()=> $("filePicker").click());
  $("filePicker").addEventListener("change", importBackup);

  // CSV exports
  $("exportIngresosCsvBtn").addEventListener("click", ()=>exportCSV("ingresos"));
  $("exportGastosCsvBtn").addEventListener("click", ()=>exportCSV("gastos"));
  $("exportCxcCsvBtn").addEventListener("click", ()=>exportCSV("cxc"));
  $("exportCxpCsvBtn").addEventListener("click", ()=>exportCSV("cxp"));
  $("exportInvCsvBtn").addEventListener("click", ()=>exportCSV("inventario"));
  $("exportCsvAllBtn").addEventListener("click", exportAllZip);

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
    console.error("wireActions error:", err);
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
    if(!confirm("¿Importar respaldo? Esto reemplaza/mezcla plantillas existentes por nombre.")) return;

    // Merge by name (unique)
    const existing = await dbGetAll("templates");
    const byName = new Map(existing.map(t=>[t.name,t]));
    for(const t of payload.templates){
      // Normalize
      if(!t.id) t.id=uid();
      t.updatedAt=Date.now();
      byName.set(t.name, t);
    }
    for(const t of byName.values()){
      await dbPut("templates", t);
    }
    state.templates = (await dbGetAll("templates")).sort((a,b)=>a.name.localeCompare(b.name));
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
    tr.innerHTML = `
      <td>${a.nombre}</td>
      <td>${a.nacimiento||""}</td>
      <td>${calcAge(a.nacimiento)}</td>
      <td>${a.numero||""}</td>
      <td>${a.ingreso||""}</td>
      <td>${a.programa}</td>
      <td>${money(a.cuota||0)}</td>
      <td>${a.ata||""}</td>
      <td>
        <button class="ghost" onclick="editAlumno('${a.id}')">Editar</button>
        <button class="ghost danger" onclick="deleteAlumno('${a.id}')">Borrar</button>
      </td>`;
    $("alTbody").appendChild(tr);
  });
}

function addOrUpdateAlumno(){
  const active = getActive();
  const id = $("addAlumnoBtn").dataset.editId || uid();

  const alumno = {
    id,
    nombre: $("alNombre").value.trim(),
    nacimiento: $("alNacimiento").value,
    numero: $("alNumero").value,
    ingreso: $("alIngreso").value || todayISO(),
    programa: $("alPrograma").value,
    cuota: Number($("alCuota").value||0),
    ata: $("alAta").value
  };

  if(!alumno.nombre){
    alert("El nombre es obligatorio");
    return;
  }

 const idx = active.alumnos.findIndex(a => a.id === id);
if (idx >= 0) active.alumnos[idx] = alumno;
else active.alumnos.push(alumno);

addCuotaPendiente(active, alumno);
saveActiveData(active);

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

function deleteAlumno(id){
  if(!confirm("¿Borrar alumno?")) return;
  const a = getActive();
  a.alumnos = a.alumnos.filter(x=>x.id!==id);
  persistActive();
  renderAlumnos();
}

function clearAlumnoForm(){
  ["alNombre","alNacimiento","alEdad","alNumero","alCuota","alAta"]
    .forEach(id => $(id).value = "");

  $("alIngreso").value = todayISO();
  $("alPrograma").value = "BASICO";
  $("addAlumnoBtn").textContent = "Guardar alumno";
  delete $("addAlumnoBtn").dataset.editId;
}
  
