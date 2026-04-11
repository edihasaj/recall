/**
 * Background service worker — bridges content scripts with the local Recall daemon.
 * Fetches compiled memories from http://localhost:7890/compile
 * and forwards them to content scripts.
 */

const DAEMON_URL = "http://localhost:7890";

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECALL_FETCH_MEMORIES") {
    fetchMemories(message.repo, message.path)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  if (message.type === "RECALL_LIST_MEMORIES") {
    listMemories(message.repo)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "RECALL_REPORT_CORRECTION") {
    reportCorrection(message.text, message.repo)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "RECALL_HEALTH") {
    checkHealth()
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchMemories(repo, path) {
  const resp = await fetch(`${DAEMON_URL}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, path }),
  });
  return resp.json();
}

async function listMemories(repo) {
  const url = repo
    ? `${DAEMON_URL}/memories?repo=${encodeURIComponent(repo)}`
    : `${DAEMON_URL}/memories`;
  const resp = await fetch(url);
  return resp.json();
}

async function reportCorrection(text, repo) {
  const resp = await fetch(`${DAEMON_URL}/correct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, repo }),
  });
  return resp.json();
}

async function checkHealth() {
  const resp = await fetch(`${DAEMON_URL}/health`);
  return resp.json();
}
