/* Existing code ... */

// =========================
// Connection Status and History Logic
// =========================

async function sendConnectionStatus(status) {
  let pCode = "";
  let fName = "";
  let lName = "";
  let fullName = ""; // For the new sheet

  // 1. Try to get from UI inputs
  try {
    pCode = document.getElementById("personnelCode")?.value?.trim() || "";
    fName = document.getElementById("firstName")?.value?.trim() || "";
    lName = document.getElementById("lastName")?.value?.trim() || "";
    if (fName && lName) {
      fullName = `${fName} ${lName}`; // Construct fullName
    }
  } catch (e) {
    console.warn("Input read failed for status:", e);
  }

  // 2. Fallback to global currentUser object
  if (!pCode && typeof currentUser !== 'undefined' && currentUser) {
    pCode = currentUser.personnelCode || "";
    fName = currentUser.firstName || "";
    lName = currentUser.lastName || "";
    if (fName && lName) {
      fullName = `${fName} ${lName}`;
    } else if (currentUser.fullName) {
      fullName = currentUser.fullName; // Use full name if available directly
    }
  }

  // 3. Last fallback to localStorage
  if (!pCode) {
    try {
      pCode = localStorage.getItem("personnelCode") || "";
      fName = localStorage.getItem("firstName") || "";
      lName = localStorage.getItem("lastName") || "";
      if (fName && lName) {
        fullName = `${fName} ${lName}`;
      }
    } catch (e) {
      console.error("Storage read failed for status:", e);
    }
  }

  // If we still don't have a code, we can't log anything
  if (!pCode) {
    console.log("Status update skipped: No personnelCode found.");
    return;
  }
  
  // Ensure fullName is populated if possible, otherwise use pCode as fallback for display
  if (!fullName) {
      fullName = pCode; // Use personnelCode if name is unavailable
  }


  const payload = {
    type: "ConnectionStatus", // This MUST match the action in Code.gs doPost
    personnelCode: pCode,
    fullName: fullName, // Send fullName for the new sheet
    connectionStatusFa: status,
    deviceTime: new Date().toISOString()
  };

  console.log("Reporting status to server:", status, "for", fullName);

  try {
    // IMPORTANT: The GAS_URL must be correctly set here.
    // If GAS_URL is not defined, this will fail. Define it near other constants.
    if (typeof GAS_URL === 'undefined' || !GAS_URL) {
        console.error("GAS_URL is not defined. Cannot send status.");
        return;
    }
    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors", // This is important - the response cannot be read
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });
    console.log("Status sent successfully.");
  } catch (err) {
    console.error("Failed to send status", err);
  }
}

// Listen for network changes automatically
// Ensure 'online' and 'offline' event listeners are correctly placed, e.g., within an init function or at the top level.
window.addEventListener("online", () => {
  sendConnectionStatus("آنلاین");
});

window.addEventListener("offline", () => {
  sendConnectionStatus("آفلاین");
});

// Helper for manual console testing
window.testStatus = () => {
    // For testing, we need to mock some values if not in a logged-in state
    const mockUser = {
        personnelCode: localStorage.getItem("personnelCode") || "TESTUSER001",
        fullName: (localStorage.getItem("firstName") || "Test") + " " + (localStorage.getItem("lastName") || "User")
    };
    // Temporarily set currentUser or ensure values are in localStorage/inputs
    // This is just for the test function to have data
    if (typeof currentUser === 'undefined') window.currentUser = mockUser;
    if (!localStorage.getItem("personnelCode")) localStorage.setItem("personnelCode", mockUser.personnelCode);
    if (!localStorage.getItem("firstName")) localStorage.setItem("firstName", "Test");
    if (!localStorage.getItem("lastName")) localStorage.setItem("lastName", "User");
    
    sendConnectionStatus("آنلاین");
};

// Make sure GAS_URL is defined somewhere accessible, e.g., with other constants:
// const GAS_URL = 'PASTE_YOUR_DEPLOYED_APPS_SCRIPT_WEB_APP_URL_HERE'; 

/* =========================
   New Function to Fetch Connection Statuses
========================= */
async function fetchConnectionStatuses() {
  if (typeof GAS_URL === 'undefined' || !GAS_URL) {
    console.error("GAS_URL is not defined. Cannot fetch statuses.");
    return [];
  }

  const url = `${GAS_URL}?action=getConnectionStatuses`;

  try {
    // Use 'no-cors' for GET as well if your GAS URL requires it,
    // but typically GET requests to GAS can be CORS enabled.
    // If you face CORS issues, you might need to adjust GAS CORS settings or use 'no-cors'.
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store" // Ensure we get the latest data
    });

    // If using 'no-cors', res.ok will always be false.
    // We rely on the content being available if the fetch itself didn't throw an error.
    if (!res.ok && res.type === 'opaque') {
        console.warn("Received opaque response for getConnectionStatuses. Assuming success due to 'no-cors'.");
        // If no-cors, we can't read the response status/body directly.
        // We'd have to rely on the Google Apps Script logs to see if it ran.
        // For a better experience, consider enabling CORS on your Apps Script Web App.
        // If you can enable CORS, remove 'no-cors' and check res.ok.
        // Let's try to parse it anyway, it might work sometimes or we can assume success based on no error thrown.
        // A more robust way would be to have the GAS return a specific success code or log entry.
        // For now, we'll proceed assuming the GAS ran if no exception was thrown.
        // If this method fails, you'll need to debug GAS execution logs.
    } else if (!res.ok) {
        console.error(`Failed to fetch connection statuses: ${res.status} ${res.statusText}`);
        return [];
    }

    // IMPORTANT: If using 'no-cors', res.json() will likely fail or return an empty object.
    // This is a limitation of 'no-cors'.
    // If you can enable CORS on your GAS Web App, remove 'no-cors' from the fetch options above,
    // and this part should work:
    const result = await res.json().catch(e => {
        console.error("Failed to parse JSON response for connection statuses. Likely due to 'no-cors'.", e);
        return { ok: false, statuses: [] }; // Return empty if parsing fails
    });

    if (result && result.ok === true && Array.isArray(result.statuses)) {
      return result.statuses;
    } else {
      console.error("Unexpected response format from getConnectionStatuses:", result);
      return [];
    }

  } catch (error) {
    console.error("Error fetching connection statuses:", error);
    return [];
  }
}

/* =========================
   Displaying Statuses (Example for Admin Panel)
========================= */

// This function would be called from your AdminPanel.html
async function displayConnectionStatuses() {
  const statuses = await fetchConnectionStatuses();
  const container = document.getElementById("connectionStatusTableBody"); // Assume you have a tbody with this ID

  if (!container) {
    console.error("Element 'connectionStatusTableBody' not found.");
    return;
  }

  // Clear previous content
  container.innerHTML = "";

  if (statuses.length === 0) {
    container.innerHTML = '<tr><td colspan="3">وضعیت اتصال یافت نشد.</td></tr>';
    return;
  }

  statuses.forEach(status => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(status.personnelCode || 'N/A')}</td>
      <td>${escapeHtml(status.fullName || 'N/A')}</td>
      <td>${escapeHtml(status.lastConnectionStatus || 'نامشخص')}</td>
      <td>${formatTimestamp(status.lastSeenTimestamp)}</td>
    `;
    container.appendChild(row);
  });
}

// Helper function to format timestamp (you might have this already)
function formatTimestamp(isoString) {
  if (!isoString) return "N/A";
  try {
    const date = new Date(isoString);
    // Using Persian date formatting if available, otherwise fallback to ISO
    return new Intl.DateTimeFormat("fa-IR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  } catch (e) {
    return isoString; // Fallback
  }
}

// Helper function to escape HTML (you might have this already)
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
 }

// Call this function when your admin page loads, e.g., in its init function
// document.addEventListener('DOMContentLoaded', () => {
//     // ... other init code ...
//     displayConnectionStatuses();
// });

// Example for window.testSendConnectionStatusMany to include fullName
window.testSendConnectionStatusMany = async function () {
  const personnelCode = 
    (document.querySelector('[name="personnelCode"]') || {}).value || 
    (window.currentUser && currentUser.personnelCode) || 
    localStorage.getItem("personnelCode") || 
    "20000745";

  const firstName = 
    (document.querySelector('[name="firstName"]') || {}).value || 
    (window.currentUser && currentUser.firstName) || 
    localStorage.getItem("firstName") || 
    "Test";
    
  const lastName = 
    (document.querySelector('[name="lastName"]') || {}).value || 
    (window.currentUser && currentUser.lastName) || 
    localStorage.getItem("lastName") || 
    "User";
    
  const fullName = `${firstName} ${lastName}`;

  const statuses = ["آنلاین", "آفلاین", "آنلاین", "آفلاین", "آنلاین"];

  for (const st of statuses) {
    const payload = {
      type: "ConnectionStatus", // Matches Code.gs doPost action
      personnelCode: personnelCode,
      fullName: fullName, // Added fullName
      connectionStatusFa: st,
      online: st === "آنلاین", // This 'online' field might not be used by backend, but good for frontend logic
      deviceTime: new Date().toISOString() // Added deviceTime
    };

    console.log("Sending to Server:", payload);

    try {
      if (typeof GAS_URL === 'undefined' || !GAS_URL) {
        console.error("GAS_URL is not defined. Cannot send status.");
        break; // Exit loop if URL is not set
      }
      await fetch(GAS_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // Use utf-8 for Persian
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error("Fetch Error:", err);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
};
