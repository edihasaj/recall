/**
 * Content script — injects a floating Recall panel into web LLM UIs.
 * Shows compiled memories and allows quick corrections.
 */

(function () {
  "use strict";

  // Avoid double injection
  if (document.getElementById("recall-panel")) return;

  // State
  let currentRepo = "";
  let isExpanded = false;
  let memories = null;
  let daemonOnline = false;

  // --- Create panel ---

  const panel = document.createElement("div");
  panel.id = "recall-panel";
  panel.innerHTML = `
    <div id="recall-toggle" title="Recall — Coding Memory">
      <span id="recall-icon">R</span>
      <span id="recall-status-dot"></span>
    </div>
    <div id="recall-body" style="display:none">
      <div id="recall-header">
        <span>Recall</span>
        <input id="recall-repo" type="text" placeholder="owner/repo" />
      </div>
      <div id="recall-content">
        <div id="recall-empty">Set a repo above, then click refresh.</div>
      </div>
      <div id="recall-actions">
        <button id="recall-refresh" title="Refresh memories">↻ Refresh</button>
        <button id="recall-copy" title="Copy to clipboard">📋 Copy</button>
      </div>
      <div id="recall-correction">
        <input id="recall-correction-input" type="text" placeholder="Report correction..." />
        <button id="recall-correction-submit">→</button>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  // --- Elements ---

  const toggle = document.getElementById("recall-toggle");
  const body = document.getElementById("recall-body");
  const content = document.getElementById("recall-content");
  const repoInput = document.getElementById("recall-repo");
  const refreshBtn = document.getElementById("recall-refresh");
  const copyBtn = document.getElementById("recall-copy");
  const correctionInput = document.getElementById("recall-correction-input");
  const correctionSubmit = document.getElementById("recall-correction-submit");
  const statusDot = document.getElementById("recall-status-dot");

  // --- Load saved repo ---

  chrome.storage.local.get(["recall_repo"], (result) => {
    if (result.recall_repo) {
      repoInput.value = result.recall_repo;
      currentRepo = result.recall_repo;
    }
  });

  // --- Toggle panel ---

  toggle.addEventListener("click", () => {
    isExpanded = !isExpanded;
    body.style.display = isExpanded ? "block" : "none";
    if (isExpanded) checkDaemon();
  });

  // --- Save repo on change ---

  repoInput.addEventListener("change", () => {
    currentRepo = repoInput.value.trim();
    chrome.storage.local.set({ recall_repo: currentRepo });
  });

  // --- Refresh ---

  refreshBtn.addEventListener("click", async () => {
    if (!currentRepo) {
      content.innerHTML = '<div class="recall-msg">Set a repo first.</div>';
      return;
    }

    content.innerHTML = '<div class="recall-msg">Loading...</div>';

    chrome.runtime.sendMessage(
      { type: "RECALL_FETCH_MEMORIES", repo: currentRepo },
      (response) => {
        if (!response?.success || !response.data?.text) {
          content.innerHTML = '<div class="recall-msg">No memories or daemon offline.</div>';
          return;
        }

        memories = response.data;
        renderMemories(response.data);
      },
    );
  });

  // --- Copy ---

  copyBtn.addEventListener("click", () => {
    if (memories?.text) {
      navigator.clipboard.writeText(memories.text);
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => (copyBtn.textContent = "📋 Copy"), 1500);
    }
  });

  // --- Correction ---

  correctionSubmit.addEventListener("click", submitCorrection);
  correctionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCorrection();
  });

  function submitCorrection() {
    const text = correctionInput.value.trim();
    if (!text) return;

    chrome.runtime.sendMessage(
      { type: "RECALL_REPORT_CORRECTION", text, repo: currentRepo },
      (response) => {
        if (response?.success) {
          correctionInput.value = "";
          const created = response.data?.created?.length ?? 0;
          const msg = document.createElement("div");
          msg.className = "recall-msg recall-success";
          msg.textContent = created > 0
            ? `${created} candidate(s) created`
            : "No pattern detected";
          content.prepend(msg);
          setTimeout(() => msg.remove(), 3000);
        }
      },
    );
  }

  // --- Render ---

  function renderMemories(data) {
    if (!data.text) {
      content.innerHTML = '<div class="recall-msg">No memories above threshold.</div>';
      return;
    }

    const escaped = data.text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    content.innerHTML = `<pre id="recall-text">${escaped}</pre>
      <div class="recall-meta">
        ${data.memories_included?.length ?? 0} included,
        ${data.memories_dropped?.length ?? 0} dropped,
        ~${data.token_estimate ?? 0} tokens
      </div>`;
  }

  // --- Health check ---

  function checkDaemon() {
    chrome.runtime.sendMessage({ type: "RECALL_HEALTH" }, (response) => {
      daemonOnline = response?.success && response?.data?.status === "ok";
      statusDot.className = daemonOnline ? "online" : "offline";
    });
  }

  // Initial check
  checkDaemon();
})();
