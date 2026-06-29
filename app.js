const DB_NAME = "attendance-pwa-db";
const DB_VERSION = 4;
const STORE_RECORDS = "records";
const STORE_PROFILE = "profile";
const STORE_CONFIG = "config";

// شناسه اسکریپت Google Apps Script شما
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzrnRxZ2XkVKll_Thp_RVm0JlJTndxU8NX_ZIcoQ2_XKeVsZOuiY6gxyNyG5mPijwNf/exec";

const GPS_WAIT_MS = 90000;
const GPS_RETRY_MS = 30000;
const GOOD_ACCURACY_METERS = 1000;
const GPS_REQUIRED = true;

const MAX_HUMAN_SPEED_MPS = 45;
const TELEPORT_DISTANCE_METERS = 100;
const MIN_TIME_FOR_LONG_DISTANCE_MS = 60000;
const ACCURACY_SUSPICIOUS_METERS = 100;

const CLOCK_RISK_GPS_CLICK_DIFF_MS = 5 * 60 * 1000;
const HIGH_GPS_WAIT_MS = 2 * 60 * 1000;
const CLOCK_DRIFT_SESSION_LIMIT_MS = 10 * 1000;
const CLOCK_DRIFT_NETWORK_LIMIT_MS = 2 * 60 * 1000;

const DEFAULT_ATTENDANCE_POLICY = "ONLINE_OR_OFFLINE";
const POLICY_NOT_ALLOWED = "NOT_ALLOWED";
const POLICY_ONLINE_ONLY = "ONLINE_ONLY";
const POLICY_OFFLINE_ONLY = "OFFLINE_ONLY";
const POLICY_ONLINE_PREFERRED = "ONLINE_PREFERRED";
const POLICY_ONLINE_OR_OFFLINE = "ONLINE_OR_OFFLINE";
const POLICY_OFFLINE_PREFERRED = "OFFLINE_PREFERRED";

let db;
let profile;
let config;
let isOnline = false;
let isClockDriftDetected = false;
let isClockDriftAdmin = false;
let isGeoFenceEnabled = false;
let isGeoFenceAdmin = false;
let lastGpsFix = null;
let lastGpsFixTime = null;
let watchId = null;
let currentSync = null;
let lastSync = null;
let isSyncing = false;
let isManualSyncing = false;
let manualSyncTimeout = null;
let appVersion = "1.0.0";
let isFormSubmitted = false;
let appElement = document.getElementById("app");
let profileForm = document.getElementById("profileForm");
let profileFormSubmitButton = document.getElementById("profileFormSubmit");
let adminForm = document.getElementById("adminForm");
let adminFormSubmitButton = document.getElementById("adminFormSubmit");
let adminMessageElement = document.getElementById("adminMessage");
let gpsToastElement = document.getElementById("gpsToast");
let attendanceRecordsElement = document.getElementById("attendanceRecords");
let lastRecordsElement = document.getElementById("lastRecords");
let syncStatusElement = document.getElementById("syncStatus");
let syncButton = document.getElementById("syncButton");
let manualSyncButton = document.getElementById("manualSyncButton");
let logoutButton = document.getElementById("logoutButton");
let loadingSpinner = document.getElementById("loadingSpinner");
let loadingOverlay = document.getElementById("loadingOverlay");
let userProfileContainer = document.getElementById("userProfileContainer");
let adminPanelContainer = document.getElementById("adminPanelContainer");
let attendanceRecordsContainer = document.getElementById("attendanceRecordsContainer");
let lastRecordsContainer = document.getElementById("lastRecordsContainer");
let syncButtonContainer = document.getElementById("syncButtonContainer");
let manualSyncButtonContainer = document.getElementById("manualSyncButtonContainer");
let logoutButtonContainer = document.getElementById("logoutButtonContainer");
let onlineBadge = document.getElementById("onlineBadge");
let syncBadge = document.getElementById("syncBadge");
let syncTimeAgo = document.getElementById("syncTimeAgo");
let gpsIcon = document.getElementById("gpsIcon");
let clockIcon = document.getElementById("clockIcon");

// IndexedDB Initialization
function initDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (event) => {
      console.error("IndexedDB error:", event.target.error);
      reject("Failed to open IndexedDB.");
    };
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: "key" });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve();
    };
  });
}

// Profile Operations
async function getProfile() {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_PROFILE], "readonly");
    const store = transaction.objectStore(STORE_PROFILE);
    const request = store.get(getUserId()); // Assuming you have a way to get the current user ID
    request.onsuccess = (event) => {
      profile = event.target.result;
      resolve(profile);
    };
    request.onerror = (event) => {
      console.error("Error getting profile:", event.target.error);
      reject("Failed to get profile.");
    };
  });
}

async function saveProfile(profileData) {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_PROFILE], "readwrite");
    const store = transaction.objectStore(STORE_PROFILE);
    const request = store.put(profileData); // Use put for upsert behavior
    request.onsuccess = () => {
      profile = profileData; // Update local profile object
      resolve();
    };
    request.onerror = (event) => {
      console.error("Error saving profile:", event.target.error);
      reject("Failed to save profile.");
    };
  });
}

// Config Operations
async function getConfig(key) {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_CONFIG], "readonly");
    const store = transaction.objectStore(STORE_CONFIG);
    const request = store.get(key);
    request.onsuccess = (event) => {
      resolve(event.target.result ? event.target.result.value : null);
    };
    request.onerror = (event) => {
      console.error(`Error getting config key "${key}":`, event.target.error);
      reject(`Failed to get config key "${key}".`);
    };
  });
}

async function setConfig(key, value) {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_CONFIG], "readwrite");
    const store = transaction.objectStore(STORE_CONFIG);
    const request = store.put({ key: key, value: value });
    request.onsuccess = () => {
      config[key] = value; // Update local config object
      resolve();
    };
    request.onerror = (event) => {
      console.error(`Error setting config key "${key}":`, event.target.error);
      reject(`Failed to set config key "${key}".`);
    };
  });
}

// Records Operations
async function saveRecord(record) {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_RECORDS], "readwrite");
    const store = transaction.objectStore(STORE_RECORDS);
    const request = store.add(record);
    request.onsuccess = (event) => {
      resolve(event.target.result); // Returns the generated record ID
    };
    request.onerror = (event) => {
      console.error("Error saving record:", event.target.error);
      reject("Failed to save record.");
    };
  });
}

async function getAllRecords() {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_RECORDS], "readonly");
    const store = transaction.objectStore(STORE_RECORDS);
    const request = store.getAll();
    request.onsuccess = (event) => {
      resolve(event.target.result);
    };
    request.onerror = (event) => {
      console.error("Error getting all records:", event.target.error);
      reject("Failed to get all records.");
    };
  });
}

async function getPendingRecords() {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_RECORDS], "readonly");
    const store = transaction.objectStore(STORE_RECORDS);
    const request = store.getAll(); // In a real app, you'd likely filter by a 'synced' flag
    request.onsuccess = (event) => {
      // Assuming records not yet synced have a `synced: false` property or lack a `synced` property
      const records = event.target.result.filter(record => !record.synced);
      resolve(records);
    };
    request.onerror = (event) => {
      console.error("Error getting pending records:", event.target.error);
      reject("Failed to get pending records.");
    };
  });
}

async function deleteRecord(recordId) {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_RECORDS], "readwrite");
    const store = transaction.objectStore(STORE_RECORDS);
    const request = store.delete(recordId);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = (event) => {
      console.error(`Error deleting record ${recordId}:`, event.target.error);
      reject(`Failed to delete record ${recordId}.`);
    };
  });
}

async function markRecordAsSynced(recordId) {
  if (!db) await initDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_RECORDS], "readwrite");
    const store = transaction.objectStore(STORE_RECORDS);
    const request = store.get(recordId);
    request.onsuccess = (event) => {
      const record = event.target.result;
      if (record) {
        record.synced = true;
        record.syncTimestamp = new Date().toISOString();
        const updateRequest = store.put(record);
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = (updateEvent) => {
          console.error(`Error updating record ${recordId} after sync:`, updateEvent.target.error);
          reject(`Failed to mark record ${recordId} as synced.`);
        };
      } else {
        resolve(); // Record not found, maybe already deleted or synced differently
      }
    };
    request.onerror = (event) => {
      console.error(`Error getting record ${recordId} for sync update:`, event.target.error);
      reject(`Failed to retrieve record ${recordId} for sync update.`);
    };
  });
}

async function markAllRecordsAsSynced() {
  if (!db) await initDb();
  const records = await getAllRecords();
  const transaction = db.transaction([STORE_RECORDS], "readwrite");
  const store = transaction.objectStore(STORE_RECORDS);
  let successCount = 0;
  let errorCount = 0;

  records.forEach(record => {
    if (!record.synced) {
      record.synced = true;
      record.syncTimestamp = new Date().toISOString();
      const request = store.put(record);
      request.onsuccess = () => {
        successCount++;
        if (successCount + errorCount === records.length) {
          console.log(`Successfully marked ${successCount} records as synced.`);
        }
      };
      request.onerror = (event) => {
        console.error(`Error marking record ${record.id} as synced:`, event.target.error);
        errorCount++;
        if (successCount + errorCount === records.length) {
          console.error(`Failed to mark ${errorCount} records as synced.`);
        }
      };
    }
  });
  // Note: This part relies on the asynchronous nature of IndexedDB put operations.
  // A more robust solution might involve Promises and async/await for each put.
}

// Utility Functions
function getUserId() {
  // Replace with your actual user ID retrieval logic
  // This could come from a logged-in session, a config value, etc.
  // For example: return localStorage.getItem("userId");
  // Or if profile is loaded: return profile?.userId;
  return "user123"; // Placeholder
}

function getProfileValue(key, defaultValue = null) {
  return profile && profile[key] !== undefined ? profile[key] : defaultValue;
}

function getConfigValue(key, defaultValue = null) {
  return config && config[key] !== undefined ? config[key] : defaultValue;
}

function updateOnlineBadge() {
  if (onlineBadge) {
    onlineBadge.textContent = isOnline ? "Online" : "Offline";
    onlineBadge.className = isOnline ? "badge bg-success" : "badge bg-danger";
  }
  if (gpsIcon) {
    gpsIcon.className = isOnline ? "fas fa-map-marker-alt text-success" : "fas fa-map-marker-alt text-danger";
  }
}

function updateSyncBadge() {
  if (syncBadge) {
    const needsSync = await getPendingRecords().then(records => records.length > 0).catch(() => true); // Assume needs sync if error
    syncBadge.textContent = needsSync ? "Needs Sync" : "Synced";
    syncBadge.className = needsSync ? "badge bg-warning text-dark" : "badge bg-info";
  }
  if (syncTimeAgo && lastSync) {
    syncTimeAgo.textContent = `Last sync: ${timeAgo(lastSync)}`;
  } else if (syncTimeAgo) {
    syncTimeAgo.textContent = "Last sync: Never";
  }
}

function updateGpsIcon() {
  if (gpsIcon) {
    if (lastGpsFix) {
      gpsIcon.className = "fas fa-map-marker-alt text-success"; // Good fix
    } else {
      gpsIcon.className = "fas fa-map-marker-alt text-warning"; // No fix yet or lost
    }
  }
}

function updateClockIcon() {
  if (clockIcon) {
    if (isClockDriftDetected) {
      clockIcon.className = "fas fa-clock text-danger";
    } else {
      clockIcon.className = "fas fa-clock text-secondary";
    }
  }
}

function showLoadingSpinner(show = true) {
  if (loadingSpinner) {
    loadingSpinner.style.display = show ? "block" : "none";
  }
  if (loadingOverlay) {
    loadingOverlay.style.display = show ? "block" : "none";
  }
}

// Function to check network status
function checkNetworkStatus() {
  isOnline = navigator.onLine;
  updateOnlineBadge();
  if (isOnline) {
    console.log("App is online.");
    // Attempt to sync if online
    syncRecords();
  } else {
    console.log("App is offline.");
    // Stop GPS watching if offline and not configured for offline use
    const attendancePolicy = getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY);
    if (attendancePolicy !== POLICY_ONLINE_ONLY && watchId) {
      // Continue GPS watching if offline is allowed
    } else if (watchId) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      console.log("Stopped GPS watching due to offline status and policy.");
    }
  }
}

// Timestamp and TimeAgo functions
function timeAgo(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

// Add event listener for network status changes
window.addEventListener("online", checkNetworkStatus);
window.addEventListener("offline", checkNetworkStatus);

// Check initial network status
checkNetworkStatus();

// --- UI Rendering Functions ---

function renderProfileForm(userProfile) {
  if (!profileForm) return;
  // Assuming userProfile is an object with keys like 'name', 'email', etc.
  // Populate the form fields
  profileForm.elements["name"].value = userProfile?.name || "";
  profileForm.elements["email"].value = userProfile?.email || "";
  // Add other fields as necessary
}

function renderAdminForm(adminConfig) {
  if (!adminForm) return;
  // Assuming adminConfig is an object with keys like 'geoFence', 'attendancePolicy', etc.
  adminForm.elements["geoFenceEnabled"].checked = adminConfig?.geoFenceEnabled || false;
  adminForm.elements["geoFenceLat"].value = adminConfig?.geoFenceLat || "";
  adminForm.elements["geoFenceLon"].value = adminConfig?.geoFenceLon || "";
  adminForm.elements["geoFenceRadius"].value = adminConfig?.geoFenceRadius || "";
  adminForm.elements["attendancePolicy"].value = adminConfig?.attendancePolicy || DEFAULT_ATTENDANCE_POLICY;
  // Add other admin settings
}

function showAdminMessage(message, type = "info") {
  if (adminMessageElement) {
    adminMessageElement.textContent = message;
    adminMessageElement.className = `alert ${type === "error" ? "alert-danger" : "alert-success"} d-none d-print-none`; // Hide on print
    adminMessageElement.style.display = "block"; // Make it visible
  }
}

function showGpsToast(message, type = "info") {
  if (gpsToastElement) {
    gpsToastElement.textContent = message;
    gpsToastElement.className = `toast ${type === "error" ? "bg-danger" : "bg-success"} text-white`; // Example styling
    // Need a way to trigger toast visibility, e.g., using Bootstrap's Toast component
    // For now, just log it:
    console.log(`GPS Toast (${type}): ${message}`);
  }
}


// --- Initialization ---
async function initializeApp() {
  showLoadingSpinner(true);
  try {
    await initDb();
    await loadConfigAndProfile();
    await loadInitialData(); // Fetch initial data from server if needed
    await renderInitialUI();
    checkNetworkStatus(); // Ensure correct online/offline status is set initially
    setupEventListeners();
    startGpsTracking();
    // Fetch messages and initial records on load
    await fetchMessages();
    await refreshUiFull(); // This will call renderLastRecords
    updateOnlineBadge();
    updateSyncBadge();
    updateGpsIcon();
    updateClockIcon();
    console.log("App initialized successfully.");
  } catch (error) {
    console.error("App initialization failed:", error);
    showAdminMessage(`Initialization failed: ${error}`, "error");
  } finally {
    showLoadingSpinner(false);
  }
}

async function loadConfigAndProfile() {
  // Load config
  config = {};
  const configKeys = ["geoFenceEnabled", "geoFenceLat", "geoFenceLon", "geoFenceRadius", "attendancePolicy", "clockDriftDetection", "appVersion"];
  for (const key of configKeys) {
    config[key] = await getConfig(key);
  }
  appVersion = config.appVersion || appVersion; // Update app version if stored
  isGeoFenceEnabled = getConfigValue("geoFenceEnabled", false);
  isGeoFenceAdmin = getProfileValue("isGeoFenceAdmin", false); // Assuming this is a profile property
  const attendancePolicy = getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY);
  isClockDriftAdmin = getProfileValue("isClockDriftAdmin", false); // Assuming this is a profile property
  const clockDriftDetection = getConfigValue("clockDriftDetection", true); // Default to true if not set

  // Load profile
  await getProfile();
  if (!profile) {
    console.warn("No profile found. User might be logged out or new.");
    // Handle case where no profile exists (e.g., redirect to login)
  } else {
    console.log("Profile loaded:", profile);
    // Set initial state based on profile or config
    isClockDriftDetected = clockDriftDetection && !isClockDriftAdmin; // Only detect if not admin and enabled
  }
}

async function loadInitialData() {
  // Example: Load last sync time
  lastSync = await getConfig("lastSync");
}

function renderInitialUI() {
  // Render profile form
  renderProfileForm(profile);
  // Render admin form if user is admin
  if (profile?.isAdmin || isGeoFenceAdmin || isClockDriftAdmin) { // Check for relevant admin roles
    renderAdminForm({
      geoFenceEnabled: getConfigValue("geoFenceEnabled"),
      geoFenceLat: getConfigValue("geoFenceLat"),
      geoFenceLon: getConfigValue("geoFenceLon"),
      geoFenceRadius: getConfigValue("geoFenceRadius"),
      attendancePolicy: getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY),
    });
    // Show admin containers
    if (adminPanelContainer) adminPanelContainer.style.display = "block";
    if (syncButtonContainer) syncButtonContainer.style.display = "block";
    if (manualSyncButtonContainer) manualSyncButtonContainer.style.display = "block";
    if (logoutButtonContainer) logoutButtonContainer.style.display = "block";
  } else {
    // Hide admin containers for non-admins
    if (adminPanelContainer) adminPanelContainer.style.display = "none";
    if (syncButtonContainer) syncButtonContainer.style.display = "none";
    if (manualSyncButtonContainer) manualSyncButtonContainer.style.display = "none";
    if (logoutButtonContainer) logoutButtonContainer.style.display = "block"; // Keep logout visible
  }

  // Show user profile container
  if (userProfileContainer) userProfileContainer.style.display = "block";
  if (attendanceRecordsContainer) attendanceRecordsContainer.style.display = "block";
  if (lastRecordsContainer) lastRecordsContainer.style.display = "block";

  // Update badges based on loaded data
  updateOnlineBadge();
  updateSyncBadge();
  updateGpsIcon();
  updateClockIcon();
}


// --- Event Listeners ---
function setupEventListeners() {
  // Profile Form Submission
  if (profileForm) {
    profileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      profileFormSubmitButton.disabled = true; // Disable button during submission
      showLoadingSpinner(true);

      const formData = new FormData(profileForm);
      const updatedProfile = {
        ...(profile || {}), // Preserve existing profile data
        name: formData.get("name"),
        email: formData.get("email"),
        // Add other profile fields from the form
      };

      try {
        await saveProfile(updatedProfile);
        console.log("Profile saved successfully.");
        showAdminMessage("Profile updated successfully.", "success");
        // Optionally refresh UI elements that depend on profile data
        refreshUi();
      } catch (error) {
        console.error("Failed to save profile:", error);
        showAdminMessage(`Error saving profile: ${error}`, "error");
      } finally {
        showLoadingSpinner(false);
        profileFormSubmitButton.disabled = false; // Re-enable button
      }
    });
  }

  // Admin Form Submission
  if (adminForm) {
    adminForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      adminFormSubmitButton.disabled = true;
      showLoadingSpinner(true);

      const formData = new FormData(adminForm);
      const updatedConfig = {
        ...(config || {}),
        geoFenceEnabled: formData.get("geoFenceEnabled") === "on",
        geoFenceLat: parseFloat(formData.get("geoFenceLat")),
        geoFenceLon: parseFloat(formData.get("geoFenceLon")),
        geoFenceRadius: parseFloat(formData.get("geoFenceRadius")),
        attendancePolicy: formData.get("attendancePolicy"),
        // Add other config settings
      };

      try {
        // Save config settings
        await setConfig("geoFenceEnabled", updatedConfig.geoFenceEnabled);
        await setConfig("geoFenceLat", updatedConfig.geoFenceLat);
        await setConfig("geoFenceLon", updatedConfig.geoFenceLon);
        await setConfig("geoFenceRadius", updatedConfig.geoFenceRadius);
        await setConfig("attendancePolicy", updatedConfig.attendancePolicy);

        // Update local state variables
        isGeoFenceEnabled = updatedConfig.geoFenceEnabled;
        const attendancePolicy = updatedConfig.attendancePolicy;

        console.log("Admin settings saved successfully.");
        showAdminMessage("Admin settings updated successfully.", "success");

        // Re-evaluate GPS tracking based on new settings
        if (isGeoFenceEnabled) {
          startGpsTracking(); // Restart if needed
        } else {
          stopGpsTracking(); // Stop if disabled
        }
        checkNetworkStatus(); // May need to re-evaluate sync behavior based on policy
        refreshUi();
      } catch (error) {
        console.error("Failed to save admin settings:", error);
        showAdminMessage(`Error saving admin settings: ${error}`, "error");
      } finally {
        showLoadingSpinner(false);
        adminFormSubmitButton.disabled = false;
      }
    });
  }

  // Sync Button
  if (syncButton) {
    syncButton.addEventListener("click", syncRecords);
  }

  // Manual Sync Button
  if (manualSyncButton) {
    manualSyncButton.addEventListener("click", forceManualSync);
  }

  // Logout Button
  if (logoutButton) {
    logoutButton.addEventListener("click", logout);
  }
}

// Function to simulate logout
function logout() {
  console.log("Logging out...");
  // Implement your actual logout logic here:
  // - Clear session data (tokens, user info)
  // - Redirect to login page
  // Example:
  // localStorage.removeItem("authToken");
  // window.location.href = "/login.html";
  showAdminMessage("Logout successful. Redirecting to login...", "success");
  setTimeout(() => {
    window.location.href = "login.html"; // Redirect to your login page
  }, 1500);
}

// --- GPS Tracking ---
function startGpsTracking() {
  const attendancePolicy = getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY);
  if (!GPS_REQUIRED && attendancePolicy === POLICY_ONLINE_ONLY && !isOnline) {
    console.log("GPS tracking skipped: Policy is ONLINE_ONLY and device is offline.");
    stopGpsTracking(); // Stop if not needed
    return;
  }

  if (watchId) {
    console.log("GPS tracking already active.");
    return;
  }

  if (!navigator.geolocation) {
    console.error("Geolocation is not supported by this browser.");
    showGpsToast("Geolocation not supported.", "error");
    return;
  }

  console.log("Starting GPS tracking...");
  showGpsToast("Getting GPS location...", "info");

  const options = {
    enableHighAccuracy: true,
    timeout: 10000, // Max wait time for the first fix
    maximumAge: 0 // Don't use cached position
  };

  watchId = navigator.geolocation.watchPosition(
    onLocationSuccess,
    onLocationError,
    options
  );

  // Set a timeout to stop watching if no fix is obtained within a certain time
  setTimeout(() => {
    if (watchId && !lastGpsFix) {
      console.warn("GPS tracking timed out. No fix obtained.");
      showGpsToast("Failed to get GPS location.", "error");
      stopGpsTracking();
    }
  }, GPS_WAIT_MS);
}

function stopGpsTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    console.log("Stopped GPS tracking.");
    lastGpsFix = null; // Clear last fix when stopping
    lastGpsFixTime = null;
    updateGpsIcon(); // Update icon to indicate no fix
  }
}

function onLocationSuccess(position) {
  console.log("GPS Success:", position);
  const { latitude, longitude, accuracy, timestamp } = position.coords;
  const currentLocation = { latitude, longitude };
  const currentLocationTime = new Date(timestamp);

  updateGpsIcon(); // Mark as having a fix

  // Store the latest successful fix
  lastGpsFix = currentLocation;
  lastGpsFixTime = currentLocationTime;

  // Log GPS details
  console.log(`Latitude: ${latitude}, Longitude: ${longitude}, Accuracy: ${accuracy}m, Timestamp: ${currentLocationTime.toISOString()}`);

  // Check if accuracy is sufficient
  if (accuracy > GOOD_ACCURACY_METERS && attendancePolicy !== POLICY_OFFLINE_ONLY) {
    showGpsToast(`Low GPS accuracy (${accuracy}m). Waiting for better signal...`, "warning");
    // Optionally, stop tracking if accuracy is consistently bad and policy requires good accuracy
    // stopGpsTracking();
    return;
  }

  // Check for teleportation or excessive speed if we have a previous fix
  if (lastGpsFix && lastGpsFixTime && lastGpsFix.latitude !== latitude && lastGpsFix.longitude !== longitude) {
    const distance = calculateDistance(lastGpsFix.latitude, lastGpsFix.longitude, latitude, longitude);
    const timeDiff = currentLocationTime.getTime() - lastGpsFixTime.getTime();

    if (distance > TELEPORT_DISTANCE_METERS && timeDiff < MIN_TIME_FOR_LONG_DISTANCE_MS) {
      console.warn(`Possible teleportation detected! Distance: ${distance}m, Time: ${timeDiff}ms`);
      showGpsToast("Possible teleportation detected. Check your location.", "warning");
      // Decide how to handle: flag the record, prevent submission, etc.
    } else if (distance / (timeDiff / 1000) > MAX_HUMAN_SPEED_MPS) {
      console.warn(`Excessive speed detected! Speed: ${distance / (timeDiff / 1000)} m/s`);
      showGpsToast("Excessive speed detected. Check your location.", "warning");
      // Decide how to handle
    }
  }

  // Update last fix details for next check
  lastGpsFix = currentLocation;
  lastGpsFixTime = currentLocationTime;

  // If the form is open and valid, enable submit button
  if (profileForm && !isFormSubmitted && profileForm.checkValidity()) {
    profileFormSubmitButton.disabled = false;
  }

  // Dismiss toast after a while if location is good
  setTimeout(() => {
    if (gpsToastElement && gpsToastElement.textContent.includes("Getting GPS location")) {
      gpsToastElement.style.display = "none";
    }
  }, 5000);
}

function onLocationError(error) {
  console.error("GPS Error:", error);
  let message = "Failed to get location.";
  switch (error.code) {
    case error.PERMISSION_DENIED:
      message = "Location request denied. Please enable location services.";
      break;
    case error.POSITION_UNAVAILABLE:
      message = "Location information is unavailable.";
      break;
    case error.TIMEOUT:
      message = "The request to get user location timed out.";
      break;
    case error.UNKNOWN_ERROR:
      message = "An unknown error occurred.";
      break;
  }
  showGpsToast(message, "error");
  stopGpsTracking(); // Stop if there's an error
}

// Haversine formula for distance calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
  const φ2 = lat2 * Math.PI / 180;
  const deltaφ = (lat2 - lat1) * Math.PI / 180;
  const deltaλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaφ / 2) * Math.sin(deltaφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(deltaλ / 2) * Math.sin(deltaλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const d = R * c; // distance in metres
  return d;
}

// --- Clock Drift Detection ---
async function checkClockDrift() {
  if (!getConfigValue("clockDriftDetection", true) || isClockDriftAdmin) {
    console.log("Clock drift detection is disabled or user is admin.");
    isClockDriftDetected = false;
    updateClockIcon();
    return;
  }

  try {
    const response = await fetch(APPS_SCRIPT_URL + "?action=getServerTime");
    if (!response.ok) {
      throw new Error(`Server time fetch failed with status: ${response.status}`);
    }
    const data = await response.json();
    if (!data.serverTime) {
      throw new Error("Invalid server time response format.");
    }

    const serverTime = new Date(data.serverTime);
    const clientTime = new Date();
    const diff = clientTime.getTime() - serverTime.getTime(); // positive if client is ahead

    console.log(`Client time: ${clientTime.toISOString()}, Server time: ${serverTime.toISOString()}, Diff: ${diff}ms`);

    // Check against session limit first
    if (Math.abs(diff) > CLOCK_DRIFT_SESSION_LIMIT_MS) {
      isClockDriftDetected = true;
      showGpsToast(`Significant clock drift detected (${(diff / 1000).toFixed(1)}s). Please sync your device time.`, "warning");
    } else {
      isClockDriftDetected = false; // Reset if within session limit
    }

    // Check against network limit if needed (e.g., for critical operations)
    if (Math.abs(diff) > CLOCK_DRIFT_NETWORK_LIMIT_MS) {
      console.warn(`Clock drift exceeds network limit: ${diff}ms`);
      // Potentially take more drastic action here if required by policy
    }

    updateClockIcon();
    // Optionally, trigger sync or disable submission if drift is too high
    // if (isClockDriftDetected) { /* ... */ }

  } catch (error) {
    console.error("Clock drift check failed:", error);
    // If clock drift check fails, we can't reliably determine drift.
    // Assume no drift or log a warning.
    // isClockDriftDetected = false; // Or keep previous state?
    // updateClockIcon();
  }
}

// --- Sync Operations ---
async function syncRecords() {
  if (isSyncing) {
    console.log("Sync already in progress.");
    return;
  }

  const attendancePolicy = getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY);
  if (!isOnline && attendancePolicy === POLICY_ONLINE_ONLY) {
    console.log("Sync skipped: Device is offline and policy requires online connection.");
    return;
  }

  isSyncing = true;
  syncButton.disabled = true;
  manualSyncButton.disabled = true;
  showLoadingSpinner(true);
  console.log("Starting sync...");

  try {
    const pendingRecords = await getPendingRecords();
    if (pendingRecords.length === 0) {
      console.log("No pending records to sync.");
      lastSync = new Date().toISOString(); // Update last sync time even if nothing to sync
      await setConfig("lastSync", lastSync);
      updateSyncBadge();
      return;
    }

    console.log(`Syncing ${pendingRecords.length} records...`);

    // Prepare records for sending (e.g., convert to JSON)
    const recordsToSend = pendingRecords.map(record => {
      // Ensure only necessary fields are sent and correct format
      return {
        userId: record.userId, // Ensure this is correctly set when saving
        timestamp: record.timestamp,
        // Add other relevant fields like location, device info, etc.
        latitude: record.latitude,
        longitude: record.longitude,
        accuracy: record.accuracy,
        // Include original ID if needed for server-side reconciliation
        localId: record.id
      };
    });

    const payload = JSON.stringify({ records: recordsToSend, appVersion: appVersion });

    const response = await fetch(APPS_SCRIPT_URL + "?action=submitAttendance", {
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Sync failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.success) {
      console.log("Sync successful:", result);
      // Mark records as synced in IndexedDB
      for (const record of pendingRecords) {
        await markRecordAsSynced(record.id);
      }
      lastSync = new Date().toISOString();
      await setConfig("lastSync", lastSync);
      showAdminMessage("Data synced successfully.", "success");
    } else {
      throw new Error(result.message || "Unknown sync error from server.");
    }
  } catch (error) {
    console.error("Sync failed:", error);
    showAdminMessage(`Sync error: ${error.message}`, "error");
    // Potentially implement retry logic here
  } finally {
    isSyncing = false;
    syncButton.disabled = false;
    manualSyncButton.disabled = false;
    showLoadingSpinner(false);
    updateSyncBadge();
  }
}

async function forceManualSync() {
  console.log("Forcing manual sync...");
  // Clear any existing sync timeout to ensure this runs immediately
  if (manualSyncTimeout) {
    clearTimeout(manualSyncTimeout);
    manualSyncTimeout = null;
  }
  await syncRecords();
}

// Function to fetch messages from the server (e.g., admin messages)
async function fetchMessages() {
  try {
    const response = await fetch(APPS_SCRIPT_URL + "?action=getMessages");
    if (!response.ok) {
      throw new Error(`Failed to fetch messages: ${response.status}`);
    }
    const data = await response.json();
    if (data.messages && data.messages.length > 0) {
      // Assuming messages format is { type: 'info'|'error', text: '...' }
      const adminMessage = data.messages.find(msg => msg.type === 'admin');
      if (adminMessage) {
        showAdminMessage(adminMessage.text, adminMessage.type);
      }
      // Handle other message types if needed
    }
  } catch (error) {
    console.error("Error fetching messages:", error);
    // Optionally show a non-critical error to the user
    // showAdminMessage("Could not fetch latest messages.", "warning");
  }
}
// --- UI Refresh Functions ---

// Refreshes only dynamic parts of the UI, like badges, status messages
function refreshUi() {
  updateOnlineBadge();
  updateSyncBadge();
  updateGpsIcon();
  updateClockIcon();
  // Update other dynamic elements if needed
}

// Refreshes the entire UI, including records and forms
async function refreshUiFull() {
  showLoadingSpinner(true);
  try {
    // Reload profile and config to ensure latest data is used
    await loadConfigAndProfile();
    renderProfileForm(profile);
    if (profile?.isAdmin || isGeoFenceAdmin || isClockDriftAdmin) { // Check for relevant admin roles
       renderAdminForm({
        geoFenceEnabled: getConfigValue("geoFenceEnabled"),
        geoFenceLat: getConfigValue("geoFenceLat"),
        geoFenceLon: getConfigValue("geoFenceLon"),
        geoFenceRadius: getConfigValue("geoFenceRadius"),
        attendancePolicy: getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY),
      });
      if (adminPanelContainer) adminPanelContainer.style.display = "block";
    } else {
      if (adminPanelContainer) adminPanelContainer.style.display = "none";
    }

    await renderLastRecords(); // Render the list of recent records

    updateOnlineBadge();
    updateSyncBadge();
    updateGpsIcon();
    updateClockIcon();
    console.log("Full UI refreshed.");
  } catch (error) {
    console.error("Failed to refresh UI fully:", error);
    showAdminMessage(`Failed to refresh UI: ${error}`, "error");
  } finally {
    showLoadingSpinner(false);
  }
}


async function renderLastRecords() {
  if (!lastRecordsElement) {
    console.warn("Element for last records not found.");
    return;
  }
  lastRecordsElement.innerHTML = ''; // Clear existing records

  try {
    // Fetch a limited number of recent records from IndexedDB
    // For simplicity, we fetch all and sort/slice. A more efficient approach
    // might use cursors with a query to get the last N records.
    let records = await getAllRecords();
    records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Sort by timestamp descending
    const recentRecords = records.slice(0, 10); // Get the latest 10 records

    if (recentRecords.length === 0) {
      lastRecordsElement.innerHTML = "<p>No attendance records found yet.</p>";
      return;
    }

    const table = document.createElement("table");
    table.className = "table table-striped table-hover"; // Bootstrap classes for styling

    // Table header
    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    const headers = ["Timestamp", "Status", "Location", "Accuracy"]; // Add more as needed
    headers.forEach(headerText => {
      const th = document.createElement("th");
      th.textContent = headerText;
      headerRow.appendChild(th);
    });

    // Table body
    const tbody = table.createTBody();
    recentRecords.forEach(record => {
      const row = tbody.insertRow();
      row.insertCell().textContent = new Date(record.timestamp).toLocaleString();
      row.insertCell().textContent = record.status || "Present"; // Assuming 'status' field exists or default to 'Present'
      const locationCell = row.insertCell();
      if (record.latitude && record.longitude) {
        const locationLink = document.createElement("a");
        locationLink.href = `https://www.google.com/maps?q=${record.latitude},${record.longitude}`;
        locationLink.textContent = `Lat: ${record.latitude.toFixed(4)}, Lon: ${record.longitude.toFixed(4)}`;
        locationLink.target = "_blank";
        locationCell.appendChild(locationLink);
      } else {
        locationCell.textContent = "N/A";
      }
      row.insertCell().textContent = record.accuracy ? `${record.accuracy.toFixed(0)}m` : "N/A";
      // Add more cells for other record details
    });

    lastRecordsElement.appendChild(table);

  } catch (error) {
    console.error("Error rendering last records:", error);
    lastRecordsElement.innerHTML = "<p class='text-danger'>Error loading records.</p>";
  }
}

// Function to handle form submission for attendance
async function submitAttendance(event) {
  event.preventDefault(); // Prevent default form submission
  if (isFormSubmitted) {
    console.log("Form already submitted for this session.");
    return;
  }

  profileFormSubmitButton.disabled = true; // Disable button to prevent double submission
  showLoadingSpinner(true);

  const attendancePolicy = getConfigValue("attendancePolicy", DEFAULT_ATTENDANCE_POLICY);

  // 1. Check Network Status
  if (!isOnline && attendancePolicy === POLICY_ONLINE_ONLY) {
    showAdminMessage("You are offline. Attendance can only be submitted online.", "error");
    profileFormSubmitButton.disabled = false;
    showLoadingSpinner(false);
    return;
  }

  // 2. Check Clock Drift
  if (isClockDriftDetected) {
    showAdminMessage("Significant clock drift detected. Please sync your device time before submitting.", "error");
    profileFormSubmitButton.disabled = false;
    showLoadingSpinner(false);
    return;
  }

  // 3. Get Geolocation (if required by policy or enabled)
  let currentLocation = null;
  let currentAccuracy = null;
  if (GPS_REQUIRED || attendancePolicy === POLICY_ONLINE_PREFERRED || attendancePolicy === POLICY_OFFLINE_PREFERRED || isGeoFenceEnabled) {
    if (!lastGpsFix) {
      showAdminMessage("Waiting for GPS location. Please ensure location services are enabled.", "warning");
      // Optionally, try to get a fix again here, or just wait
      startGpsTracking(); // Try to get a fix
      profileFormSubmitButton.disabled = false;
      showLoadingSpinner(false);
      return;
    }
    currentLocation = lastGpsFix;
    currentAccuracy = position.coords.accuracy; // Use accuracy from the latest fix
  }

  // 4. Geo-fence Check (if enabled)
  if (isGeoFenceEnabled && !profile?.isAdmin && !isGeoFenceAdmin) { // Don't check for admins
    if (!currentLocation) {
      showAdminMessage("Cannot perform geo-fence check without location.", "error");
      profileFormSubmitButton.disabled = false;
      showLoadingSpinner(false);
      return;
    }
    const geoFenceLat = parseFloat(getConfigValue("geoFenceLat"));
    const geoFenceLon = parseFloat(getConfigValue("geoFenceLon"));
    const geoFenceRadius = parseFloat(getConfigValue("geoFenceRadius"));

    if (isNaN(geoFenceLat) || isNaN(geoFenceLon) || isNaN(geoFenceRadius)) {
      showAdminMessage("Geo-fence is enabled but misconfigured. Please contact administrator.", "error");
      profileFormSubmitButton.disabled = false;
      showLoadingSpinner(false);
      return;
    }

    const distance = calculateDistance(currentLocation.latitude, currentLocation.longitude, geoFenceLat, geoFenceLon);
    if (distance > geoFenceRadius) {
      showAdminMessage(`You are outside the allowed geo-fence area (Distance: ${distance.toFixed(0)}m, Radius: ${geoFenceRadius}m).`, "error");
      profileFormSubmitButton.disabled = false;
      showLoadingSpinner(false);
      return;
    }
  }

  // 5. Prepare Record
  const record = {
    userId: getUserId(), // Ensure this is correctly populated
    timestamp: new Date().toISOString(),
    // location: currentLocation, // Store as object or separate fields
    latitude: currentLocation?.latitude,
    longitude: currentLocation?.longitude,
    accuracy: currentAccuracy,
    // Add other relevant data: device info, IP address (if available), etc.
    // Example: deviceType: /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ? "Mobile" : "Desktop",
    // Example: userAgent: navigator.userAgent,
    synced: false, // Mark as not synced initially
    syncTimestamp: null,
    status: "Present" // Default status, can be overridden
  };

  // 6. Save Record Locally
  try {
    const recordId = await saveRecord(record);
    console.log("Record saved locally with ID:", recordId);
    isFormSubmitted = true; // Mark as submitted for this session
    showAdminMessage("Attendance recorded successfully (saved locally).", "success");

    // Optionally, trigger sync immediately after saving if online
    if (isOnline) {
      await syncRecords();
    } else {
      updateSyncBadge(); // Update badge to show 'Needs Sync'
    }

    // Clear form or reset UI
    profileForm.reset();
    setTimeout(() => {
      isFormSubmitted = false; // Allow submission again after some time or on refresh
      profileFormSubmitButton.disabled = false; // Re-enable button for next potential entry
      showLoadingSpinner(false);
      // Optionally, navigate away or show a confirmation message
      refreshUiFull(); // Refresh to show the new record in the list
    }, 3000); // Give user time to see the success message

  } catch (error) {
    console.error("Failed to save attendance record:", error);
    showAdminMessage(`Error saving attendance: ${error}`, "error");
    profileFormSubmitButton.disabled = false;
    showLoadingSpinner(false);
  }
}

// Attach the submitAttendance function to the form's submit event
// Make sure this is called after the form is rendered or elements are available
document.addEventListener("DOMContentLoaded", () => {
  // Initial setup
  initializeApp();

  // Set up form submission listener *after* app initialization and element availability
  if (profileForm) {
    profileForm.addEventListener("submit", submitAttendance);
  }

  // Ensure the submit button is initially disabled until data is valid/ready
  if (profileFormSubmitButton) {
    profileFormSubmitButton.disabled = true;
  }

  // Start periodic checks
  setInterval(checkNetworkStatus, 60000); // Check network every minute
  setInterval(checkClockDrift, 300000); // Check clock drift every 5 minutes
  setInterval(updateSyncBadge, 30000); // Update sync badge periodically
  setInterval(refreshUi, 120000); // Refresh UI elements like badges every 2 minutes
  setInterval(fetchMessages, 300000); // Fetch admin messages every 5 minutes
});
// --- Utility Functions ---

// Helper to get current server time for clock drift checks
// Note: This function is now async and calls checkClockDrift directly.
// The original `getServerTime` standalone function might be redundant if not used elsewhere.

// Function to force a full UI refresh, including fetching latest records
function refreshUiFull() {
  // Existing implementation assumed to be in Part 3
  console.log("refreshUiFull called (implementation in Part 3).");
  // Placeholder call to ensure it's recognized as defined elsewhere
  // This should be implemented properly in Part 3 or relevant section.
  // Example: return initializeApp(); // Or a more specific refresh logic
}

// Function to show admin messages
// Assuming this is defined in Part 3
function showAdminMessage(message, type) {
  console.log(`Admin Message (${type}): ${message}`);
  // Placeholder for actual implementation in Part 3
}

// Function to show GPS toasts
// Assuming this is defined in Part 3
function showGpsToast(message, type) {
  console.log(`GPS Toast (${type}): ${message}`);
  // Placeholder for actual implementation in Part 3
}

// --- Initialization ---
// Assume initializeApp() is defined in Part 3 and handles setup.
// The DOMContentLoaded listener in Part 3 calls initializeApp().

// --- GPS Tracking ---
// Assume startGpsTracking, stopGpsTracking, onLocationSuccess, onLocationError, calculateDistance are defined in Part 3.

// --- Clock Drift Detection ---
// Assume checkClockDrift is defined in Part 3.

// --- Sync Operations ---
// Assume syncRecords, forceManualSync, fetchMessages are defined in Part 3.

// --- Helper function for element selection (optional, but good practice) ---
function $(selector) {
  return document.querySelector(selector);
}

// --- Initial call to start the app ---
// This is now handled by the DOMContentLoaded listener in Part 3.
// document.addEventListener("DOMContentLoaded", initializeApp);

// --- Mock functions / Placeholders ---
// These are here to satisfy potential calls in other parts of the code
// that might not be fully implemented or are placeholders.
// Replace these with actual implementations.

function setStatus(message, type = "info") {
  console.log(`setStatus: ${message} (${type})`);
  // Example: Update a status bar element
  const statusElement = $("#statusMessage"); // Assuming an element with id="statusMessage"
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = `status-${type}`; // Add CSS classes for styling
  }
}

function renderLastRecords() {
   console.log("renderLastRecords called (implementation in Part 3).");
   // Placeholder call
   // This function should be fully implemented in Part 3.
}

function showLocalDebugInfo() {
  console.log("Showing local debug info...");
  // Implement logic to display local debug data (e.g., from localStorage, config)
}

function updateOnlineBadge() {
  console.log("updateOnlineBadge called (implementation in Part 3).");
}

function updateSyncBadge() {
  console.log("updateSyncBadge called (implementation in Part 3).");
}

function updateGpsIcon() {
    console.log("updateGpsIcon called (implementation in Part 3).");
}

function updateClockIcon() {
    console.log("updateClockIcon called (implementation in Part 3).");
}


// --- Final check for the end of the file ---
// Ensure all necessary functions are defined and called appropriately.
// The structure implies functions defined earlier (Parts 1-3) are used here.
// If there were syntax errors in the original, this part might need adjustment.
console.log("JavaScript code loaded.");
