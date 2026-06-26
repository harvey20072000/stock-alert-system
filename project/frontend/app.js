/* ============================================================
   警示主控台 — 前端邏輯
   - 規則資料來源：GitHub repo 裡的 rules/rules.json
   - 讀寫方式：直接呼叫 GitHub REST API（Contents endpoint）
     瀏覽器端用使用者自己貼上的 Personal Access Token 簽署請求，
     Token 只存在這台瀏覽器的 localStorage，不會經過任何中間伺服器。
   - 新增 / 編輯 / 刪除 / 啟用切換 都會立刻寫回 GitHub（每個操作各自獨立
     commit 一次），不需要另外按「推送」按鈕。同步進行中會鎖住清單避免
     並發操作互相衝突；若同步失敗，畫面上的變更會自動還原並提示錯誤。
   - 如果不想用 Token 直接寫回 GitHub，也可以用「複製 JSON」按鈕，
     把目前的規則手動貼到 GitHub 網頁版編輯器存檔（零風險、但要手動）。
   ============================================================ */

const TOKEN_STORAGE_KEY = "alertConsole.githubToken";
const OVERRIDE_STORAGE_KEY = "alertConsole.repoOverride";
// rules.json 在 repo 裡的固定路徑，對應這個專案自己的目錄結構。
// 如果你把 rules.json 搬到別的位置，改這個常數就好，不需要在 UI 上額外曝露這個設定。
const RULES_PATH = "rules/rules.json";

/** 每種 condition_type 對應要顯示哪些 params 欄位 */
const PARAM_SCHEMAS = {
  ma_deviation: [
    { key: "ma_period", label: "均線天數 (ma_period)", type: "number", default: 60 },
  ],
  price_change_from_base: [
    { key: "base_price", label: "基準價 (base_price)", type: "number", default: 100 },
  ],
  drawdown_from_high: [
    { key: "lookback_days", label: "回看天數 (lookback_days)", type: "number", default: 1260 },
  ],
  rsi: [
    { key: "rsi_period", label: "RSI 週期 (rsi_period)", type: "number", default: 14 },
  ],
};

const CONDITION_LABELS = {
  ma_deviation: (params) => `MA(${params.ma_period ?? 60}) DEV`,
  price_change_from_base: () => "PRICE Δ",
  drawdown_from_high: () => "DRAWDOWN",
  rsi: (params) => `RSI(${params.rsi_period ?? 14})`,
};

/** 應用狀態 */
const state = {
  config: null,
  rules: [],
  fileSha: null,
  syncing: false, // 是否有一次「寫回 GitHub」正在進行中，用來避免並發衝突
};

// ── DOM 參照 ─────────────────────────────────────────────
const el = (id) => document.getElementById(id);
const connDot = el("connDot");
const statusbar = el("statusbar");
const ruleList = el("ruleList");
const ruleCount = el("ruleCount");
const emptyState = el("emptyState");
const syncIndicator = el("syncIndicator");

// ============================================================
// 設定面板：自動偵測 repo 位置 + Token 輸入
// ============================================================

/**
 * 嘗試從目前網址自動判斷這個頁面是被哪個 repo 透過 GitHub Pages 部署的：
 *   - User/Org page:  https://{owner}.github.io/          → repo 通常叫 {owner}.github.io
 *   - Project page:   https://{owner}.github.io/{repo}/.. → repo 是路徑的第一段
 * 如果是自訂網域（custom domain）就無法自動判斷，需要在「進階設定」手動填。
 */
function detectRepoFromLocation() {
  const host = window.location.hostname;
  const m = host.match(/^([^.]+)\.github\.io$/i);
  if (!m) return null;
  const owner = m[1];
  const segments = window.location.pathname.split("/").filter(Boolean);
  const repo = segments.length > 0 ? segments[0] : `${owner}.github.io`;
  return { owner, repo };
}

/** 查詢 repo 的預設分支；公開 repo 不需要 Token 也能查（私有 repo 才需要） */
async function detectDefaultBranch(owner, repo, token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.default_branch || null;
  } catch {
    return null;
  }
}

let detectedRepo = null; // { owner, repo }，純自動偵測結果，不含 branch（branch 另外查）

function loadToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}
function saveToken(token) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}
function clearToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function loadOverride() {
  try {
    const raw = localStorage.getItem(OVERRIDE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveOverride(override) {
  localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(override));
}
function clearOverride() {
  localStorage.removeItem(OVERRIDE_STORAGE_KEY);
}

function readAdvancedOverrideForm() {
  return {
    owner: el("cfgOwner").value.trim(),
    repo: el("cfgRepo").value.trim(),
    branch: el("cfgBranch").value.trim(),
  };
}

function fillAdvancedOverrideForm(override) {
  el("cfgOwner").value = override?.owner || "";
  el("cfgRepo").value = override?.repo || "";
  el("cfgBranch").value = override?.branch || "";
}

/** 更新畫面上「偵測到的部署位置」那一行文字，回傳目前實際要用的 {owner, repo} */
function renderDetectedRepo() {
  const wrap = el("detectedRepoText").closest(".detected-repo");
  const override = loadOverride();
  const owner = override.owner || detectedRepo?.owner;
  const repo = override.repo || detectedRepo?.repo;

  if (!owner || !repo) {
    el("detectedRepoText").textContent = "自動偵測失敗，請在下方「進階設定」手動填入 owner / repo";
    wrap.classList.add("is-error");
    el("advancedConfig").hidden = false;
    el("btnToggleAdvanced").textContent = "進階設定 ▴";
    return null;
  }
  wrap.classList.remove("is-error");
  el("detectedRepoText").textContent = `${owner}/${repo}${override.branch ? `  @ ${override.branch}` : ""}`;
  return { owner, repo };
}

el("btnToggleConfig").addEventListener("click", () => {
  const panel = el("configPanel");
  panel.hidden = !panel.hidden;
});

el("btnToggleAdvanced").addEventListener("click", () => {
  const panel = el("advancedConfig");
  panel.hidden = !panel.hidden;
  el("btnToggleAdvanced").textContent = panel.hidden ? "進階設定 ▾" : "進階設定 ▴";
});

el("btnSaveConfig").addEventListener("click", async () => {
  const token = el("cfgToken").value.trim();
  const override = readAdvancedOverrideForm();

  if (!token) {
    setStatus("請貼上 GitHub Token 才能連線。", "error");
    return;
  }

  const resolved = override.owner && override.repo ? override : detectedRepo;
  if (!resolved?.owner || !resolved?.repo) {
    setStatus("找不到 repo 資訊，請在「進階設定」手動填入 owner / repo。", "error");
    el("advancedConfig").hidden = false;
    return;
  }

  saveToken(token);
  saveOverride(override);
  renderDetectedRepo();
  await connectWithResolvedConfig(token, resolved.owner, resolved.repo, override.branch);
});

el("btnClearConfig").addEventListener("click", () => {
  clearToken();
  clearOverride();
  el("cfgToken").value = "";
  fillAdvancedOverrideForm(null);
  state.config = null;
  setConnected(false);
  renderDetectedRepo();
  setStatus("已清除本機連線設定。", "");
});

/** 補上 branch（自動查詢或用使用者覆寫值），組成完整 config 並連線讀取規則 */
async function connectWithResolvedConfig(token, owner, repo, branchOverride) {
  setStatus("連線中…", "");
  const branch = branchOverride || (await detectDefaultBranch(owner, repo, token)) || "main";
  state.config = { token, owner, repo, branch };
  await fetchRulesFromGitHub();
}

// ============================================================
// GitHub Contents API：讀取 / 寫入 rules.json
// ============================================================
function apiUrl(cfg) {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${RULES_PATH}`;
}

/** base64 <-> Unicode 字串（規則名稱含中文，需正確處理 UTF-8） */
function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
function b64DecodeUnicode(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchRulesFromGitHub() {
  const cfg = state.config;
  if (!cfg) return;
  setStatus("讀取 rules.json 中…", "");
  try {
    const res = await fetch(`${apiUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (res.status === 404) {
      // 檔案還不存在：視為空規則清單，之後第一次「推送」會自動建立檔案
      state.rules = [];
      state.fileSha = null;
      setConnected(true);
      setStatus("找不到 rules.json，將在第一次推送時自動建立。", "ok");
      renderRules();
      return;
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const jsonText = b64DecodeUnicode(data.content);
    const parsed = JSON.parse(jsonText);
    state.rules = parsed.rules || [];
    state.fileSha = data.sha;
    setConnected(true);
    setStatus(`已連線，讀取到 ${state.rules.length} 筆規則。`, "ok");
    renderRules();
  } catch (err) {
    console.error(err);
    setConnected(false);
    setStatus(`連線失敗：${err.message}`, "error");
  }
}

/** 單純負責把目前的 state.rules 整份 PUT 回 GitHub；失敗會 throw，交給呼叫端處理 UI */
async function syncRulesToGitHub() {
  const cfg = state.config;
  if (!cfg) throw new Error("尚未設定 GitHub 連線資訊");

  const payload = { rules: state.rules };
  const content = b64EncodeUnicode(JSON.stringify(payload, null, 2) + "\n");
  const body = {
    message: `chore: update rules.json via Alert Console (${new Date().toISOString()})`,
    content,
    branch: cfg.branch,
  };
  if (state.fileSha) body.sha = state.fileSha;

  const res = await fetch(apiUrl(cfg), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  state.fileSha = data.content.sha;
}

function setConnected(ok) {
  connDot.classList.toggle("is-connected", ok);
  connDot.classList.toggle("is-error", !ok && !!state.config);
}

function setStatus(text, kind) {
  statusbar.textContent = text;
  statusbar.classList.remove("is-error", "is-ok");
  if (kind === "error") statusbar.classList.add("is-error");
  if (kind === "ok") statusbar.classList.add("is-ok");
}

/** 鎖住清單、停用「新增」按鈕，避免同步進行中又觸發另一次衝突的寫入 */
function setBusy(isBusy) {
  state.syncing = isBusy;
  ruleList.classList.toggle("is-syncing", isBusy);
  el("btnAdd").disabled = isBusy;
  if (syncIndicator) {
    syncIndicator.textContent = isBusy ? "⏳ 同步中…" : "● 即時同步";
    syncIndicator.classList.toggle("is-busy", isBusy);
  }
}

/**
 * 所有「會改變規則」的操作（新增/編輯/刪除/啟用切換）統一從這裡進來：
 *   1. 先記住目前的 state.rules 當作還原點
 *   2. 執行 mutateFn 直接修改 state.rules（樂觀更新，畫面馬上反應）
 *   3. 立刻呼叫 syncRulesToGitHub() 寫回 GitHub
 *   4. 失敗就整個還原回步驟1的狀態，並提示錯誤；不會留下「畫面跟 GitHub 不一致」的情況
 */
async function applyAndSync(mutateFn, successMsg) {
  if (state.syncing) {
    setStatus("正在同步上一個變更，請稍候再試一次。", "error");
    return false;
  }

  const snapshotRules = JSON.parse(JSON.stringify(state.rules));
  const snapshotSha = state.fileSha;

  setBusy(true);
  mutateFn();
  renderRules();
  setStatus("同步到 GitHub 中…", "");

  try {
    await syncRulesToGitHub();
    setStatus(successMsg || "已同步到 GitHub，下次排程執行就會套用新規則。", "ok");
    return true;
  } catch (err) {
    console.error(err);
    state.rules = snapshotRules;
    state.fileSha = snapshotSha;
    renderRules();
    setStatus(`同步失敗，變更已還原：${err.message}`, "error");
    return false;
  } finally {
    setBusy(false);
  }
}

// ============================================================
// 規則清單渲染
// ============================================================
function renderRules() {
  ruleList.innerHTML = "";
  ruleCount.textContent = `${state.rules.length} 筆`;
  emptyState.hidden = state.rules.length > 0;

  state.rules.forEach((rule) => {
    ruleList.appendChild(renderRuleRow(rule));
  });
}

function exprLabel(rule) {
  const labelFn = CONDITION_LABELS[rule.condition_type];
  const left = labelFn ? labelFn(rule.params || {}) : rule.condition_type;
  return `${left} ${rule.operator} ${rule.value}`;
}

function ledClass(rule) {
  if (!rule.enabled) return "is-disabled";
  // 前端本身不會去打 yfinance 拿即時報價，是否「觸發」這個資訊
  // 來自 GitHub Actions 寫回的 state.json（這裡先用靜態占位邏輯，
  // 之後可以擴充成讀取 state/state.json 來顯示真正的即時狀態）。
  return "is-armed";
}

function renderRuleRow(rule) {
  const row = document.createElement("div");
  row.className = "rule-row";
  row.dataset.id = rule.id;

  row.innerHTML = `
    <span class="led ${ledClass(rule)}"></span>
    <div class="rule-row__main">
      <span class="rule-row__name">${escapeHtml(rule.name || rule.id)}</span>
      <span class="rule-row__expr">${escapeHtml(exprLabel(rule))}</span>
    </div>
    <span class="rule-row__symbol">${escapeHtml(rule.symbol)}</span>
    <label class="toggle">
      <input type="checkbox" class="js-enable-toggle" ${rule.enabled ? "checked" : ""} />
      <span class="toggle__track"></span>
    </label>
    <div class="rule-row__ops">
      <button class="icon-btn js-edit" type="button" title="編輯">✎</button>
      <button class="icon-btn js-delete" type="button" title="刪除">🗑</button>
    </div>
  `;

  row.querySelector(".js-enable-toggle").addEventListener("change", async (e) => {
    const next = e.target.checked;
    await applyAndSync(
      () => {
        rule.enabled = next;
      },
      `已${next ? "啟用" : "停用"}「${rule.name || rule.id}」，已同步到 GitHub。`
    );
  });
  row.querySelector(".js-edit").addEventListener("click", () => openDrawer(rule));
  row.querySelector(".js-delete").addEventListener("click", async () => {
    if (!confirm(`確定要刪除規則「${rule.name || rule.id}」嗎？這會立刻同步到 GitHub。`)) return;
    await applyAndSync(() => {
      state.rules = state.rules.filter((r) => r.id !== rule.id);
    }, `已刪除「${rule.name || rule.id}」，已同步到 GitHub。`);
  });

  return row;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ============================================================
// 新增 / 編輯規則 Drawer
// ============================================================
const overlay = el("overlay");
const ruleForm = el("ruleForm");

function openDrawer(rule) {
  ruleForm.reset();
  el("fId").value = rule?.id || "";
  el("fName").value = rule?.name || "";
  el("fSymbol").value = rule?.symbol || "";
  el("fConditionType").value = rule?.condition_type || "ma_deviation";
  el("fOperator").value = rule?.operator || ">";
  el("fValue").value = rule?.value ?? "";
  el("fNotifyTelegram").checked = (rule?.notify || ["telegram"]).includes("telegram");
  el("fEnabled").checked = rule?.enabled ?? true;
  el("drawerTitle").textContent = rule ? "編輯警示" : "新增警示";

  renderParamFields(el("fConditionType").value, rule?.params || {});
  overlay.hidden = false;
}

function closeDrawer() {
  overlay.hidden = true;
}

function renderParamFields(conditionType, currentParams) {
  const container = el("paramFields");
  container.innerHTML = "";
  const schema = PARAM_SCHEMAS[conditionType] || [];
  schema.forEach((field) => {
    const wrapper = document.createElement("label");
    const value = currentParams[field.key] ?? field.default;
    wrapper.innerHTML = `${field.label}
      <input type="${field.type}" data-param="${field.key}" value="${value}" step="any" required />`;
    container.appendChild(wrapper);
  });
}

el("fConditionType").addEventListener("change", (e) => {
  renderParamFields(e.target.value, {});
});

el("btnAdd").addEventListener("click", () => openDrawer(null));
el("btnCloseDrawer").addEventListener("click", closeDrawer);
el("btnCancelForm").addEventListener("click", closeDrawer);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeDrawer();
});

function slugify(name, symbol) {
  const base = (name || symbol || "rule")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || "rule"}_${Date.now().toString(36)}`;
}

ruleForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const conditionType = el("fConditionType").value;
  const params = {};
  document.querySelectorAll("#paramFields [data-param]").forEach((input) => {
    params[input.dataset.param] = Number(input.value);
  });

  const id = el("fId").value || slugify(el("fName").value, el("fSymbol").value);
  const notify = el("fNotifyTelegram").checked ? ["telegram"] : [];
  const isEdit = Boolean(el("fId").value);

  const ruleData = {
    id,
    name: el("fName").value.trim(),
    symbol: el("fSymbol").value.trim(),
    enabled: el("fEnabled").checked,
    condition_type: conditionType,
    operator: el("fOperator").value,
    value: Number(el("fValue").value),
    params,
    notify,
    created_at: new Date().toISOString(),
  };

  const submitBtn = ruleForm.querySelector('button[type="submit"]');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "同步到 GitHub 中…";

  const ok = await applyAndSync(
    () => {
      const existingIdx = state.rules.findIndex((r) => r.id === id);
      if (existingIdx >= 0) {
        ruleData.created_at = state.rules[existingIdx].created_at || ruleData.created_at;
        state.rules[existingIdx] = ruleData;
      } else {
        state.rules.push(ruleData);
      }
    },
    `已${isEdit ? "更新" : "新增"}「${ruleData.name || ruleData.id}」，已同步到 GitHub。`
  );

  submitBtn.disabled = false;
  submitBtn.textContent = originalLabel;

  // 同步失敗時不關閉抽屜，讓使用者可以直接按一次「儲存規則」重試，不用重新輸入
  if (ok) closeDrawer();
});

// ============================================================
// 其他工具按鈕
// ============================================================
el("btnReload").addEventListener("click", () => {
  if (state.config) fetchRulesFromGitHub();
  else setStatus("尚未設定 GitHub 連線資訊，無法重新載入。", "error");
});

el("btnExport").addEventListener("click", async () => {
  const text = JSON.stringify({ rules: state.rules }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setStatus("已複製目前的 rules.json 內容到剪貼簿，可手動貼到 GitHub 網頁版編輯器存檔。", "ok");
  } catch {
    // 部分瀏覽器/環境不允許 clipboard API，退而求其次用 alert 顯示內容
    alert(text);
  }
});

// ============================================================
// 初始化
// ============================================================
(async function init() {
  detectedRepo = detectRepoFromLocation();
  const override = loadOverride();
  fillAdvancedOverrideForm(override);
  if (override.owner || override.repo || override.branch) {
    el("advancedConfig").hidden = false;
    el("btnToggleAdvanced").textContent = "進階設定 ▴";
  }
  renderDetectedRepo();

  const token = loadToken();
  if (!token) {
    el("configPanel").hidden = false;
    renderRules();
    return;
  }

  el("cfgToken").value = token;
  const resolved = override.owner && override.repo ? override : detectedRepo;
  if (resolved?.owner && resolved?.repo) {
    await connectWithResolvedConfig(token, resolved.owner, resolved.repo, override.branch);
  } else {
    el("configPanel").hidden = false;
    setStatus("找不到 repo 資訊，請在「連線設定」的進階設定手動填入 owner / repo。", "error");
    renderRules();
  }
})();
