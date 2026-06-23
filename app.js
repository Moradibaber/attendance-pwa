const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 2;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwpdfapAKi9QLxdam2ZfAakx9Ygf0XwOOPrmz9K__6wfaemr-2qhpJEFusapw9JJyvZ/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;

let db = null;
let currentPhoto = "";
let pendingLocation = null;
let pendingLocationPromise = null;
let syncRunning = false;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {

  db = await openDb();

  bindEvents();
  await loadProfile();
  await refreshUi();

  updateOnlineBadge();

  if (navigator.onLine) {
    syncPendingRecords();
  }

  window.addEventListener("online", () => {
    updateOnlineBadge();
    syncPendingRecords();
  });

  window.addEventListener("offline", updateOnlineBadge);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }

});

function bindEvents() {

  $("saveProfileBtn")?.addEventListener("click", saveProfile);
  $("recordBtn")?.addEventListener("click", startAttendanceCapture);
  $("photoInput")?.addEventListener("change", handlePhotoSelected);

}

async function startAttendanceCapture() {

  try {
    await getProfile();
  } catch (error) {
    setStatus(error.message);
    return;
  }

  currentPhoto = "";
  pendingLocation = null;
  pendingLocationPromise = null;

  $("photoInput").value = "";

  setStatus("دوربین باز می‌شود...");

  $("photoInput").click();

  setTimeout(() => {

    if (isGeolocationUsable()) {
      setStatus("در حال دریافت GPS...");
      pendingLocationPromise = getLocationWithWatch(GPS_WAIT_MS);
    } else {
      setStatus("GPS در دسترس نیست.");
    }

  }, 500);

}

async function handlePhotoSelected() {

  const file = $("photoInput").files?.[0];

  if (!file) {
    setStatus("عکسی انتخاب نشد.");
    return;
  }

  try {

    setStatus("در حال آماده سازی عکس،صبور باشید ...");
    currentPhoto = await compressImage(file);

    if ($("photoPreview")) {
      $("photoPreview").src = currentPhoto;
      $("photoPreview").style.display = "block";
    }

    if (pendingLocationPromise) {
      pendingLocation = await pendingLocationPromise;
    }

    if (!hasValidLocation(pendingLocation) && isGeolocationUsable()) {
      setStatus("در حال تلاش مجدد برای GPS...");
      pendingLocation = await getLocationWithWatch(GPS_RETRY_MS);
    }

    await createRecord("تردد");

  } catch (err) {
    setStatus("خطا در پردازش عکس");
  }

}

function openDb() {

  return new Promise((resolve,reject)=>{

    const req=indexedDB.open(DB_NAME,DB_VERSION);

    req.onupgradeneeded=e=>{

      const db=e.target.result;

      if(!db.objectStoreNames.contains(STORE_RECORDS)){

        const store=db.createObjectStore(STORE_RECORDS,{keyPath:"id",autoIncrement:true});
        store.createIndex("status","status");

      }

      if(!db.objectStoreNames.contains(STORE_PROFILE)){
        db.createObjectStore(STORE_PROFILE,{keyPath:"id"});
      }

    };

    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);

  });

}

function dbPut(store,value){

  return new Promise((resolve,reject)=>{

    const tx=db.transaction(store,"readwrite");
    const st=tx.objectStore(store);

    const req=st.put(value);

    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);

  });

}

function dbGet(store,key){

  return new Promise((resolve,reject)=>{

    const tx=db.transaction(store,"readonly");
    const st=tx.objectStore(store);

    const req=st.get(key);

    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);

  });

}

function dbGetAll(store){

  return new Promise((resolve,reject)=>{

    const tx=db.transaction(store,"readonly");
    const st=tx.objectStore(store);

    const req=st.getAll();

    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);

  });

}

async function saveProfile() {
  const profile = {
    id: "main",
    personnelCode: $("personnelCode")?.value.trim(),
    firstName: $("firstName")?.value.trim(),
    lastName: $("lastName")?.value.trim()
  };

  if (!profile.personnelCode || !profile.firstName || !profile.lastName) {
    setStatus("اطلاعات پرسنلی کامل نیست.");
    return;
  }

  await dbPut(STORE_PROFILE, profile);

  // --- بخش جدید برای نمایش پیام موقت ---
  const profileStatus = document.getElementById("profileStatus");
  if (profileStatus) {
    profileStatus.textContent = "مشخصات با موفقیت ثبت شد ✅";
    profileStatus.className = "status online small-status";

    // بعد از 3000 میلی‌ثانیه (3 ثانیه) پیام پاک شود
    setTimeout(() => {
      profileStatus.textContent = "";
      profileStatus.className = "status small-status";
    }, 3000);
  } else {
    // اگر المنت مخصوص را در HTML ندارید، از همان تابع عمومی استفاده می‌کند
    setStatus("مشخصات با موفقیت ثبت شد.");
  }
}

async function loadProfile(){

  const p=await dbGet(STORE_PROFILE,"main");
  if(!p)return;

  $("personnelCode").value=p.personnelCode||"";
  $("firstName").value=p.firstName||"";
  $("lastName").value=p.lastName||"";

}

async function getProfile(){

  const saved=await dbGet(STORE_PROFILE,"main");

  const profile={
    personnelCode:$("personnelCode")?.value.trim()||saved?.personnelCode||"",
    firstName:$("firstName")?.value.trim()||saved?.firstName||"",
    lastName:$("lastName")?.value.trim()||saved?.lastName||""
  };

  if(!profile.personnelCode||!profile.firstName||!profile.lastName){
    throw new Error("مشخصات پرسنلی کامل نیست.");
  }

  await dbPut(STORE_PROFILE,{id:"main",...profile});

  return profile;

}

async function createRecord(type){

  const profile=await getProfile();

  const loc=hasValidLocation(pendingLocation)
  ?pendingLocation
  :emptyLocation("not_received","GPS دریافت نشد");

  const now=new Date();

  const record={

    personnelCode:profile.personnelCode,
    firstName:profile.firstName,
    lastName:profile.lastName,

    type:type,

    recordDate:getPersianDate(now),
    recordHour:getTime(now),

    latitude:loc.latitude||"",
    longitude:loc.longitude||"",
    accuracy:loc.accuracy||"",

    deviceTime:now.toISOString(),

    photo:currentPhoto,

    status:"pending",

    createdAt:now.toISOString()

  };

  await dbPut(STORE_RECORDS,record);

  if(loc.latitude){
    setStatus("تردد با GPS ذخیره شد.");
  }else{
    setStatus("تردد ذخیره شد (بدون GPS).");
  }

  await refreshUi();

  if(navigator.onLine){
    syncPendingRecords();
  }

}

function isGeolocationUsable(){

  if(!navigator.geolocation)return false;
  if(!window.isSecureContext)return false;

  return true;

}

function getLocationWithWatch(waitMs){

  return new Promise(resolve=>{

    if(!isGeolocationUsable()){
      resolve(emptyLocation("unavailable","GPS در دسترس نیست"));
      return;
    }

    let done=false;
    let best=null;

    const finish=loc=>{

      if(done)return;
      done=true;

      navigator.geolocation.clearWatch(watchId);

      if(hasValidLocation(loc))resolve(loc);
      else if(hasValidLocation(best))resolve(best);
      else resolve(emptyLocation("timeout","GPS دریافت نشد"));

    };

    const watchId=navigator.geolocation.watchPosition(

      pos=>{

        const loc={
          latitude:pos.coords.latitude,
          longitude:pos.coords.longitude,
          accuracy:pos.coords.accuracy,
          status:"ok"
        };

        best=chooseBetterLocation(best,loc);

        if(loc.accuracy<=GOOD_ACCURACY_METERS){
          finish(loc);
        }

      },

      ()=>{},

      {
        enableHighAccuracy:true,
        maximumAge:30000,
        timeout:waitMs
      }

    );

    setTimeout(()=>finish(best),waitMs);

  });

}

function hasValidLocation(l){

  if(!l)return false;
  if(l.status!=="ok")return false;

  return l.latitude!==""&&l.longitude!=="";

}

function emptyLocation(status,error){

  return{
    latitude:"",
    longitude:"",
    accuracy:"",
    status,
    error
  };

}

function chooseBetterLocation(a,b){

  if(!a)return b;
  if(!b)return a;

  return (b.accuracy||999999)<=(a.accuracy||999999)?b:a;

}

async function syncPendingRecords(){

  if(syncRunning)return;

  if(!navigator.onLine)return;

  syncRunning=true;

  const records=await dbGetAll(STORE_RECORDS);

  const list=records.filter(r=>r.status==="pending"||r.status==="failed");

  if(!list.length){

    setSyncStatus("چیزی برای ارسال نیست");
    syncRunning=false;
    return;

  }

  setSyncStatus("در حال ارسال...");

  for(const r of list){

    try{

      const res=await fetch(APPS_SCRIPT_URL,{
        method:"POST",
        headers:{'Content-Type':'text/plain;charset=utf-8'},
        body:JSON.stringify(r)
      });

      let result={};

      try{
        result=await res.json();
      }catch{}

      if(result.ok){

        r.status="sent";
        await dbPut(STORE_RECORDS,r);

        if(result.message){
          showAdminMessage(result.message);
        }

      }else{

        r.status="failed";
        await dbPut(STORE_RECORDS,r);

      }

    }catch{

      r.status="failed";
      await dbPut(STORE_RECORDS,r);

    }

  }

  syncRunning=false;

  setSyncStatus("ارسال انجام شد");

  refreshUi();

}

async function refreshUi(){

  const rec=await dbGetAll(STORE_RECORDS);

  $("pendingCount").textContent=rec.filter(r=>r.status==="pending").length;
  $("sentCount").textContent=rec.filter(r=>r.status==="sent").length;
  $("failedCount").textContent=rec.filter(r=>r.status==="failed").length;

  renderRecords(rec);

}

function renderRecords(records){

  if(!records.length){

    $("recordsList").innerHTML="<p>ترددی ثبت نشده</p>";
    return;

  }

  const sorted=[...records].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));

  $("recordsList").innerHTML=sorted.slice(0,20).map(r=>`
  <div class="record-item compact-record">
  <span>${escapeHtml(r.recordDate)}</span>
  <span>${escapeHtml(r.recordHour)}</span>
  </div>
  `).join("");

}

function updateOnlineBadge(){

  if(navigator.onLine){

    $("onlineBadge").textContent="آنلاین";
    $("onlineBadge").className="status online";

  }else{

    $("onlineBadge").textContent="آفلاین";
    $("onlineBadge").className="status offline";

  }

}

function setStatus(m){

  $("captureStatus")&&( $("captureStatus").textContent=m );

}

function setSyncStatus(m){

  $("syncStatus")&&( $("syncStatus").textContent=m );

}

function showAdminMessage(m){

  const msg="پیام مدیر: "+m;

  setSyncStatus(msg);

  alert(msg);

}

function getPersianDate(d){

  return new Intl.DateTimeFormat("fa-IR-u-ca-persian",{
  year:"numeric",
  month:"2-digit",
  day:"2-digit"
  }).format(d);

}

function getTime(d){

  return new Intl.DateTimeFormat("fa-IR",{
  hour:"2-digit",
  minute:"2-digit",
  second:"2-digit",
  hour12:false
  }).format(d);

}

function compressImage(file){

  return new Promise((resolve,reject)=>{

    const reader=new FileReader();

    reader.onload=e=>{

      const img=new Image();

      img.onload=()=>{

        const canvas=document.createElement("canvas");

        const MAX=220;

        let w=img.width;
        let h=img.height;

        if(w>h){
          if(w>MAX){h=h*(MAX/w);w=MAX;}
        }else{
          if(h>MAX){w=w*(MAX/h);h=MAX;}
        }

        canvas.width=w;
        canvas.height=h;

        const ctx=canvas.getContext("2d");

        ctx.fillStyle="#fff";
        ctx.fillRect(0,0,w,h);

        ctx.drawImage(img,0,0,w,h);

        canvas.toBlob(blob=>{

          const r=new FileReader();

          r.onloadend=()=>resolve(r.result);

          r.readAsDataURL(blob);

        },"image/jpeg",0.7);

      };

      img.src=e.target.result;

    };

    reader.readAsDataURL(file);

  });

}

function escapeHtml(v){

  return String(v)
  .replaceAll("&","&amp;")
  .replaceAll("<","&lt;")
  .replaceAll(">","&gt;")
  .replaceAll('"',"&quot;")
  .replaceAll("'","&#039;");

}
