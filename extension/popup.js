/** HackBrowser Popup — Direct Firefox API calls (no sendMessage needed) */

const statusEl = document.getElementById("status");
const containersEl = document.getElementById("containers");
const formPanel = document.getElementById("formPanel");
const addBtn = document.getElementById("addBtn");
const cancelBtn = document.getElementById("cancelBtn");
const saveBtn = document.getElementById("saveBtn");

let selectedColor = "blue";

// ─── Color picker ───
document.getElementById("colorRow").addEventListener("click", (e) => {
  const opt = e.target.closest(".color-opt");
  if (!opt) return;
  document.querySelectorAll(".color-opt").forEach((el) => el.classList.remove("selected"));
  opt.classList.add("selected");
  selectedColor = opt.dataset.color;
});

// ─── Show/hide form ───
addBtn.addEventListener("click", () => {
  formPanel.classList.add("visible");
  addBtn.style.display = "none";
  document.getElementById("fName").focus();
});

cancelBtn.addEventListener("click", () => {
  formPanel.classList.remove("visible");
  addBtn.style.display = "";
  clearForm();
});

function clearForm() {
  document.getElementById("fName").value = "";
  document.getElementById("fRole").value = "";
  selectedColor = "blue";
  document.querySelectorAll(".color-opt").forEach((el) => el.classList.remove("selected"));
  document.querySelector(".color-opt.blue").classList.add("selected");
}

// ─── Container CRUD — direct Firefox API calls ───

async function getContainers() {
  const identities = await browser.contextualIdentities.query({});
  const meta = (await browser.storage.local.get("containerMeta")).containerMeta || {};
  const list = [];
  for (const id of identities) {
    if (!id.name.startsWith("HB: ")) continue;
    const tabs = await browser.tabs.query({ cookieStoreId: id.cookieStoreId });
    const m = meta[id.cookieStoreId] || {};
    list.push({
      cookieStoreId: id.cookieStoreId,
      name: m.name || id.name.replace("HB: ", ""),
      role: m.role || "",
      color: id.color,
      tabCount: tabs.length,
    });
  }
  return list;
}

async function createContainer(name, role, color) {
  const identity = await browser.contextualIdentities.create({
    name: `HB: ${name}`,
    color: color || "blue",
    icon: "fingerprint",
  });

  // Save role metadata
  const meta = (await browser.storage.local.get("containerMeta")).containerMeta || {};
  meta[identity.cookieStoreId] = { name, role };
  await browser.storage.local.set({ containerMeta: meta });

  // Open a tab in this container
  await browser.tabs.create({ cookieStoreId: identity.cookieStoreId });

  // Notify background (for WS sync to tool)
  browser.runtime.sendMessage({
    action: "containerChanged",
    cookieStoreId: identity.cookieStoreId,
    type: "created",
    name, role, color,
  }).catch(() => {}); // ignore if background not ready

  return identity;
}

async function deleteContainer(cookieStoreId) {
  // Close tabs first
  const tabs = await browser.tabs.query({ cookieStoreId });
  for (const tab of tabs) {
    await browser.tabs.remove(tab.id).catch(() => {});
  }

  await browser.contextualIdentities.remove(cookieStoreId);

  // Clean metadata
  const meta = (await browser.storage.local.get("containerMeta")).containerMeta || {};
  delete meta[cookieStoreId];
  await browser.storage.local.set({ containerMeta: meta });

  // Notify background
  browser.runtime.sendMessage({
    action: "containerChanged",
    cookieStoreId,
    type: "deleted",
  }).catch(() => {});
}

// ─── Save handler ───
saveBtn.addEventListener("click", async () => {
  const name = document.getElementById("fName").value.trim();
  const role = document.getElementById("fRole").value.trim();
  if (!name || !role) { alert("Name and role are required"); return; }

  try {
    saveBtn.disabled = true;
    saveBtn.textContent = "Creating...";
    await createContainer(name, role, selectedColor);
    formPanel.classList.remove("visible");
    addBtn.style.display = "";
    clearForm();
    await render();
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Create";
  }
});

// ─── Render ───
async function render() {
  try {
    const containers = await getContainers();

    // Check WS status from background
    let connected = false;
    try {
      const state = await browser.runtime.sendMessage({ action: "getWsStatus" });
      connected = state && state.connected;
    } catch {}

    statusEl.textContent = connected ? "connected" : "offline";
    statusEl.className = "status " + (connected ? "connected" : "disconnected");

    if (containers.length === 0) {
      containersEl.innerHTML = '<div class="empty">No containers — click + to add</div>';
      return;
    }

    let html = "";
    for (const c of containers) {
      html += `
        <div class="container-card ${c.color || 'blue'}">
          <div class="cinfo">
            <div class="cname">${esc(c.name)}</div>
            <div class="crole">${esc(c.role)}</div>
          </div>
          <div class="ctabs">${c.tabCount} tab${c.tabCount !== 1 ? 's' : ''}</div>
          <button class="cbtn del" title="Remove" data-id="${esc(c.cookieStoreId)}">×</button>
        </div>
      `;
    }
    containersEl.innerHTML = html;

    containersEl.querySelectorAll(".cbtn.del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this container?")) return;
        try {
          await deleteContainer(btn.dataset.id);
          await render();
        } catch (err) {
          alert("Error: " + err.message);
        }
      });
    });
  } catch (err) {
    containersEl.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

render();
setInterval(render, 3000);
