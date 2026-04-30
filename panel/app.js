const $ = (id) => document.getElementById(id);

const keyInput = $("panelKey");
const statusEl = $("status");
const summaryEl = $("summary");
const usersEl = $("users");
const codesEl = $("codes");
const createdCodesEl = $("createdCodes");

const state = {
  key: localStorage.getItem("panelKey") || "",
};

keyInput.value = state.key;

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": state.key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

function setStatus(msg, error = false) {
  statusEl.textContent = msg;
  statusEl.style.color = error ? "#f87171" : "#93c5fd";
}

function renderSummary(data) {
  const rows = [
    ["Admin chat_id", data.adminChatId || "-"],
    ["Bot ejecución", data.botRunning ? "Sí" : "No"],
    ["Procesos activos", `${data.runningJobs || 0}/${data.maxParallelJobs || "-"}`],
    ["Límite por chat", data.maxParallelPerChat || "-"],
    ["URL panel", data.panelUrl || "-"],
    ["Licencias activas", data.activeLicenses],
    ["Códigos totales", data.totalCodes],
    ["Códigos disponibles", data.availableCodes],
    ["Códigos usados", data.usedCodes],
    ["Tarea", data.task?.state || data.task?.taskState || "-"],
    ["Próxima tarea", data.task?.nextRun || "-"],
  ];
  summaryEl.innerHTML = rows.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join("");
}

function renderUsers(users) {
  if (!users.length) {
    usersEl.innerHTML = "<small>Sin usuarios.</small>";
    return;
  }
  usersEl.innerHTML = `
    <table>
      <thead>
        <tr><th>chat_id</th><th>usuario</th><th>nombre</th><th>vence</th><th>última actividad</th></tr>
      </thead>
      <tbody>
        ${users
          .map(
            (u) => `<tr>
              <td>${u.chatId || ""}</td>
              <td>@${u.username || "-"}</td>
              <td>${[u.firstName || "", u.lastName || ""].join(" ").trim() || "-"}</td>
              <td>${u.expiresAt || "-"}</td>
              <td>${u.lastSeenAt || "-"}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderCodes(codes) {
  if (!codes.length) {
    codesEl.innerHTML = "<small>Sin códigos.</small>";
    return;
  }
  codesEl.innerHTML = `
    <table>
      <thead>
        <tr><th>código</th><th>días</th><th>estado</th><th>usado por</th><th>creado</th></tr>
      </thead>
      <tbody>
        ${codes
          .map((c) => {
            const state = c.revokedAt ? "revocado" : c.usedBy ? "usado" : "disponible";
            return `<tr>
              <td>${c.code}</td>
              <td>${c.days}</td>
              <td>${state}</td>
              <td>${c.usedBy || "-"}</td>
              <td>${c.createdAt || "-"}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

async function refresh() {
  try {
    const [summary, users, codes] = await Promise.all([
      api("/api/admin/summary"),
      api("/api/admin/users"),
      api("/api/admin/codes"),
    ]);
    renderSummary(summary);
    renderUsers(users.users || []);
    renderCodes(codes.codes || []);
    setStatus("Conectado.");
  } catch (error) {
    setStatus(`Error: ${error.message}`, true);
  }
}

$("saveKey").addEventListener("click", () => {
  state.key = keyInput.value.trim();
  localStorage.setItem("panelKey", state.key);
  setStatus("Clave guardada localmente.");
});

$("refresh").addEventListener("click", refresh);

$("createCodes").addEventListener("click", async () => {
  try {
    const days = Number($("codeDays").value);
    const quantity = Number($("codeQty").value);
    const r = await api("/api/admin/create-codes", "POST", { days, quantity });
    createdCodesEl.textContent = (r.codes || []).join("\n");
    await refresh();
  } catch (error) {
    setStatus(`Error: ${error.message}`, true);
  }
});

$("grantBtn").addEventListener("click", async () => {
  try {
    const chatId = $("grantChatId").value.trim();
    const days = Number($("grantDays").value);
    await api("/api/admin/grant-user", "POST", { chatId, days });
    await refresh();
  } catch (error) {
    setStatus(`Error: ${error.message}`, true);
  }
});

$("revokeBtn").addEventListener("click", async () => {
  try {
    const chatId = $("grantChatId").value.trim();
    await api("/api/admin/revoke-user", "POST", { chatId });
    await refresh();
  } catch (error) {
    setStatus(`Error: ${error.message}`, true);
  }
});

$("clearCapturesBtn").addEventListener("click", async () => {
  try {
    const r = await api("/api/admin/clear-captures", "POST");
    setStatus(
      r.removed
        ? `Capturas eliminadas: ${r.removed}. Espacio liberado: ${r.formatted || r.totalBytes || 0}`
        : "No había capturas para eliminar."
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`, true);
  }
});

refresh();
