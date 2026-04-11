const dot = document.getElementById("dot");
const statusText = document.getElementById("status-text");
const repoInput = document.getElementById("repo");
const daemonUrlInput = document.getElementById("daemon-url");

// Load saved settings
chrome.storage.local.get(["recall_repo", "recall_daemon_url"], (result) => {
  if (result.recall_repo) repoInput.value = result.recall_repo;
  daemonUrlInput.value = result.recall_daemon_url || "http://localhost:7890";
  checkHealth();
});

// Save on change
repoInput.addEventListener("change", () => {
  chrome.storage.local.set({ recall_repo: repoInput.value.trim() });
});

daemonUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ recall_daemon_url: daemonUrlInput.value.trim() });
  checkHealth();
});

function checkHealth() {
  chrome.runtime.sendMessage({ type: "RECALL_HEALTH" }, (response) => {
    if (response?.success && response?.data?.status === "ok") {
      dot.className = "dot online";
      statusText.textContent = `Daemon online (v${response.data.version ?? "?"})`;
    } else {
      dot.className = "dot offline";
      statusText.textContent = "Daemon offline";
    }
  });
}
