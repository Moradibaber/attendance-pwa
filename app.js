const CONFIG = {
  appsScriptUrl: "https://script.google.com/macros/s/AKfycbxyDC-BSJQ4FT83v7-1IA4iUNdtIhIEsbymKsM8y5hchbqFSXI7sBn9BhpAuWucijs/exec",
  retentionDaysForSentRecords: 90,
  geoTimeoutMs: 120000,
  geoMaximumAgeMs: 600000,
  imageMaxWidth: 240,
  imageQuality: 0.25
};

const DB_NAME = "attendance-offline-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_SETTINGS = "settings";

let db;
let compressedPhotoDataUrl = "";

const $ = (id) => document.getElementById(id);

window.addEventListener("load", async () => {

  db = await openDb();
  await loadProfile();

  bindEvents();
  updateOnlineBadge();
  refreshUi();

});

window.addEventListener("online", updateOnlineBadge);
window.addEventListener("offline", updateOnlineBadge);

function bindEvents(){

$("saveProfileBtn").addEventListener("click", saveProfile);

$("recordBtn").addEventListener("click", ()=>{

$("photoInput").click();

});

$("photoInput").addEventListener("change", async (e)=>{

await handlePhoto(e);

await createRecord("تردد");

});

$("syncBtn").addEventListener("click", syncPendingRecords);

$("backupBtn").addEventListener("click", downloadBackup);

}

function openDb(){

return new Promise((resolve,reject)=>{

const req=indexedDB.open(DB_NAME,DB_VERSION);

req.onupgradeneeded=()=>{

const db=req.result;

if(!db.objectStoreNames.contains(STORE_RECORDS)){

const store=db.createObjectStore(STORE_RECORDS,{keyPath:"id"});

store.createIndex("status","status",{unique:false});

}

if(!db.objectStoreNames.contains(STORE_SETTINGS)){

db.createObjectStore(STORE_SETTINGS,{keyPath:"key"});

}

};

req.onsuccess=()=>resolve(req.result);
req.onerror=()=>reject(req.error);

});

}

function tx(name,mode="readonly"){

return db.transaction(name,mode).objectStore(name);

}

function dbPut(store,val){

return new Promise((res,rej)=>{

const r=tx(store,"readwrite").put(val);

r.onsuccess=()=>res(val);
r.onerror=()=>rej(r.error);

});

}

function dbGet(store,key){

return new Promise((res,rej)=>{

const r=tx(store).get(key);

r.onsuccess=()=>res(r.result);
r.onerror=()=>rej(r.error);

});

}

function dbGetAll(store){

return new Promise((res,rej)=>{

const r=tx(store).getAll();

r.onsuccess=()=>res(r.result||[]);
r.onerror=()=>rej(r.error);

});

}

function dbDelete(store,key){

return new Promise((res,rej)=>{

const r=tx(store,"readwrite").delete(key);

r.onsuccess=()=>res();
r.onerror=()=>rej(r.error);

});

}

function updateOnlineBadge(){

$("onlineBadge").textContent=navigator.onLine?"وضعیت: آنلاین":"وضعیت: آفلاین";

}

async function saveProfile(){

const p=getProfile();

if(!p.personnelCode||!p.firstName||!p.lastName){

alert("مشخصات کامل نیست");

return;

}

await dbPut(STORE_SETTINGS,{key:"profile",value:p});

}

function getProfile(){

return{

personnelCode:$("personnelCode").value.trim(),
firstName:$("firstName").value.trim(),
lastName:$("lastName").value.trim()

};

}

async function loadProfile(){

const row=await dbGet(STORE_SETTINGS,"profile");

if(!row?.value)return;

$("personnelCode").value=row.value.personnelCode||"";
$("firstName").value=row.value.firstName||"";
$("lastName").value=row.value.lastName||"";

}

async function handlePhoto(e){

const file=e.target.files?.[0];

if(!file)return;

compressedPhotoDataUrl=await compressImage(file);

$("photoPreview").innerHTML=`<img src="${compressedPhotoDataUrl}">`;

}

function compressImage(file){

return new Promise((resolve)=>{

const img=new Image();

const reader=new FileReader();

reader.onload=()=>img.src=reader.result;

img.onload=()=>{

const scale=Math.min(1,CONFIG.imageMaxWidth/img.width);

const canvas=document.createElement("canvas");

canvas.width=img.width*scale;

canvas.height=img.height*scale;

const ctx=canvas.getContext("2d");

ctx.drawImage(img,0,0,canvas.width,canvas.height);

resolve(canvas.toDataURL("image/jpeg",CONFIG.imageQuality));

};

reader.readAsDataURL(file);

});

}

async function createRecord(type){

const profile=getProfile();

if(!profile.personnelCode){

alert("مشخصات ذخیره نشده");

return;

}

$("captureStatus").textContent="در حال دریافت GPS...";

let pos=null;

try{

pos=await getLocation();

}catch{}

const now=new Date();

const id=crypto.randomUUID();

const rec={

id:id,
personnelCode:profile.personnelCode,
firstName:profile.firstName,
lastName:profile.lastName,
recordType:type,
recordDate:getPersianDate(),
recordTime:toLocalTime(now),
deviceTime:now.toISOString(),
latitude:pos?.coords?.latitude??"",
longitude:pos?.coords?.longitude??"",
accuracy:pos?.coords?.accuracy??"",
photo:compressedPhotoDataUrl,
status:"pending",
createdAt:now.toISOString(),
sentAt:""

};

await dbPut(STORE_RECORDS,rec);

compressedPhotoDataUrl="";

$("photoPreview").innerHTML="";

$("captureStatus").textContent="ثبت شد";

await refreshUi();

if(navigator.onLine){

await syncPendingRecords();

}

}

function getLocation(){

return new Promise((res,rej)=>{

navigator.geolocation.getCurrentPosition(res,rej,{

enableHighAccuracy:false,
timeout:CONFIG.geoTimeoutMs,
maximumAge:CONFIG.geoMaximumAgeMs

});

});

}

async function syncPendingRecords(){

if(!navigator.onLine)return;

const all=await dbGetAll(STORE_RECORDS);

const pending=all.filter(r=>r.status!=="sent");

for(const r of pending){

try{

const resp=await fetch(CONFIG.appsScriptUrl,{

method:"POST",
headers:{"Content-Type":"text/plain"},
body:JSON.stringify(r)

});

const result=await resp.json();

if(result.ok){

r.status="sent";
r.sentAt=new Date().toISOString();

await dbPut(STORE_RECORDS,r);

}

}catch{

r.status="failed";

await dbPut(STORE_RECORDS,r);

}

}

refreshUi();

}

async function refreshUi(){

const records=await dbGetAll(STORE_RECORDS);

$("pendingCount").textContent=records.filter(r=>r.status==="pending").length;

$("sentCount").textContent=records.filter(r=>r.status==="sent").length;

$("failedCount").textContent=records.filter(r=>r.status==="failed").length;

}

async function downloadBackup(){

const records=await dbGetAll(STORE_RECORDS);

const data=JSON.stringify(records,null,2);

const blob=new Blob([data],{type:"application/json"});

const url=URL.createObjectURL(blob);

const a=document.createElement("a");

a.href=url;

a.download="attendance-backup.json";

a.click();

}

function toLocalTime(d){

return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;

}

function getPersianDate(){

return new Intl.DateTimeFormat("fa-IR-u-ca-persian",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

}
