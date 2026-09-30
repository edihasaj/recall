// Keep every platform available in the HTML, including without JavaScript.
const button = document.querySelector("[data-platform-download]");
const platform = navigator.userAgentData?.platform || navigator.platform || "";
const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1);
const release = "https://github.com/edihasaj/recall/releases/latest/download/";

if (button && !mobile) {
  if (/Mac/i.test(platform)) {
    button.href = `${release}Recall.app.zip`;
    button.textContent = "Download for macOS";
  } else if (/Win/i.test(platform)) {
    // Reduced user agents cannot reliably identify ARM. Label the default.
    button.href = `${release}recall-tray-amd64.exe`;
    button.textContent = "Download for Windows x64";
    const note = document.querySelector("[data-platform-note]");
    if (note) {
      note.href = "#windows-downloads";
      note.textContent = "EXE needs Node.js + Recall CLI. First install or ARM64? See options.";
    }
  } else if (/Linux/i.test(platform)) {
    button.href = "#linux-install";
    button.textContent = "Install on Linux";
  }
}
