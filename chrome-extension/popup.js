const shareButton = document.querySelector("#share");
const deepButton = document.querySelector("#deep-share");
const message = document.querySelector("#message");
const progress = document.querySelector("#progress");
const pairing = document.querySelector("#pairing");
const pairingCode = document.querySelector("#pairing-code");
const pairButton = document.querySelector("#pair");
let pairingToken = "";

function showPairing(show = true) {
  pairing.classList.toggle("hidden", !show);
  if (show) setTimeout(() => pairingCode.focus(), 20);
}

async function loadPairingToken() {
  pairingToken = (await chrome.storage.local.get("argusPairingToken")).argusPairingToken || "";
  showPairing(!pairingToken);
}

function setBusy(busy, text = "") {
  shareButton.disabled = busy;
  deepButton.disabled = busy;
  progress.classList.toggle("hidden", !busy);
  if (text) progress.querySelector("small").textContent = text;
}

async function activeWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open a normal web page before sharing");
  return tab;
}

async function saveSnapshot(result) {
  if (!pairingToken) {
    showPairing();
    throw new Error("Pair this extension with Argus before sharing a tab");
  }
  const response = await fetch("http://127.0.0.1:4175/api/browser-context", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${pairingToken}` },
    body: JSON.stringify(result),
  });
  if (response.status === 401) {
    pairingToken = "";
    await chrome.storage.local.remove("argusPairingToken");
    showPairing();
  }
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Argus did not accept the page");
  message.textContent = `Shared “${result.title}” · ${Math.round(result.content.length / 1024).toLocaleString()} KB. Attach it from the AI composer.`;
}

pairButton.addEventListener("click", async () => {
  const code = pairingCode.value.replace(/\D/g, "");
  if (code.length !== 6) { message.textContent = "Enter the 6-digit code shown by Argus."; return; }
  pairButton.disabled = true;
  try {
    const response = await fetch("http://127.0.0.1:4175/api/browser-extension/pair/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.token) throw new Error(result.error || "Argus rejected the pairing code");
    pairingToken = result.token;
    await chrome.storage.local.set({ argusPairingToken: pairingToken });
    pairingCode.value = "";
    showPairing(false);
    message.textContent = "Paired securely with Argus. You can now share this tab.";
  } catch (error) { message.textContent = error.message.includes("fetch") ? "Argus is not running at 127.0.0.1:4175." : error.message; }
  finally { pairButton.disabled = false; }
});

shareButton.addEventListener("click", async () => {
  setBusy(true, "Reading the current page…");
  try {
    const tab = await activeWebTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll("script,style,noscript,svg,canvas,input,textarea,select,button").forEach((node) => node.remove());
        return { title: document.title || location.hostname, url: location.href, content: (clone.innerText || clone.textContent || "").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, 18_000_000) };
      },
    });
    await saveSnapshot(result);
  } catch (error) { message.textContent = error.message.includes("fetch") ? "Argus is not running at 127.0.0.1:4175." : error.message; }
  finally { setBusy(false); }
});

deepButton.addEventListener("click", async () => {
  setBusy(true, "Finding Grafana’s scrollable log area…");
  message.textContent = "Keep this popup open while Argus walks through the logs.";
  try {
    const tab = await activeWebTab();
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const candidates = [document.scrollingElement, ...document.querySelectorAll("div,main,section")].filter(Boolean).filter((element) => {
          const style = getComputedStyle(element);
          return element.scrollHeight > element.clientHeight + 120 && (element === document.scrollingElement || ["auto", "scroll"].includes(style.overflowY));
        });
        const target = candidates.sort((a, b) => (b.scrollHeight * Math.max(b.clientWidth, 1)) - (a.scrollHeight * Math.max(a.clientWidth, 1)))[0] || document.scrollingElement;
        const originalTop = target.scrollTop;
        const lines = [];
        const seen = new Set();
        const maximumCharacters = 18_000_000;
        const started = Date.now();
        let characterCount = 0;
        let steps = 0;
        const collect = () => {
          const text = (target.innerText || document.body.innerText || "").trim();
          for (const line of text.split(/\n/)) {
            const normalized = line.trimEnd();
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            lines.push(normalized);
            characterCount += normalized.length + 1;
            if (characterCount >= maximumCharacters) break;
          }
        };
        try {
          target.scrollTop = 0;
          await wait(350);
          let unchanged = 0;
          while (steps < 650 && Date.now() - started < 110_000 && characterCount < maximumCharacters) {
            collect();
            const maximumTop = Math.max(0, target.scrollHeight - target.clientHeight);
            if (target.scrollTop >= maximumTop - 2) {
              unchanged += 1;
              if (unchanged >= 4) break;
            } else unchanged = 0;
            const previousTop = target.scrollTop;
            target.scrollTop = Math.min(maximumTop, target.scrollTop + Math.max(220, target.clientHeight * 0.72));
            await wait(180);
            if (target.scrollTop === previousTop && target.scrollTop < maximumTop) await wait(350);
            steps += 1;
          }
          collect();
        } finally { target.scrollTop = originalTop; }
        const capped = characterCount >= maximumCharacters || steps >= 650 || Date.now() - started >= 110_000;
        const pageContext = (document.body.innerText || "").slice(0, 40_000);
        const details = ["Deep browser capture", `Scrollable area: ${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`, `Scroll steps: ${steps}`, `Unique rendered lines: ${lines.length}`, capped ? "Safety limit reached: narrow the Grafana time range for another capture." : "Reached the end of the scrollable content.", "", "PAGE AND QUERY CONTEXT", pageContext, "", "CAPTURED LOG CONTENT", ...lines];
        return { title: `${document.title || location.hostname} · deep capture`, url: location.href, content: details.join("\n").slice(0, maximumCharacters) };
      },
    });
    await saveSnapshot(result);
  } catch (error) { message.textContent = error.message.includes("fetch") ? "Argus is not running at 127.0.0.1:4175." : error.message; }
  finally { setBusy(false); }
});

loadPairingToken().catch(() => showPairing());
