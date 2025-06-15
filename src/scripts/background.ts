// background.ts

import { differenceInSeconds, formatDistanceToNow, formatISO, isValid, parseISO } from "date-fns";

// const destChatName: string = "Trojan on Solana - Odysseus";
const destChatName = "Ext Test R"

chrome.runtime.onInstalled.addListener(() => {
  console.log("Telegram CA Monitor installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Telegram CA Monitor started");
});

// chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
//   if (
//     changeInfo.status === "complete" &&
//     tab.url?.startsWith("https://web.telegram.org/")
//   ) {
//     console.log("[Background] Telegram tab updated. Triggering scan...");

//     // Trigger scan via content script
//     chrome.scripting.executeScript({
//       target: { tabId },
//       func: () => {
//         window.postMessage({ type: "START_SCAN" }, "*");
//       },
//     });
//   }
// });

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: "*://web.telegram.org/*" });
  for (const tab of tabs) {
    if (tab.id) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.postMessage({ type: "START_SCAN" }, "*");
        },
      });
    }
  }
});


interface ForwardRequest {
  ca: string;
  chatTitle: string;
  timestamp: string;
  ticker: string;
}

interface ProcessedCAEntry {
  ticker: string;
  firstSeen: string; // when first detected
  lastSeen: string; // when most recently seen
}
type ProcessedCAsMap = Record<string, ProcessedCAEntry>;

const QUEUE_STORAGE_KEY = "forwardQueue";
const PROCESSED_CAS_KEY = "processedCAs";

const MAX_PROCESSED_AGE = 3 * 24 * 60 * 60; // 3 days in seconds

let forwardQueue: ForwardRequest[] = [];
let processedCAsCache: ProcessedCAsMap = {};
let isProcessingQueue = false;

function initializeBackgroundState() {
  loadQueueFromStorage();
  loadProcessedCAsFromStorage().then(pruneOldProcessedCAs);
  startTelegramPolling();
}

chrome.runtime.onStartup.addListener(initializeBackgroundState);
chrome.runtime.onInstalled.addListener(initializeBackgroundState);

async function saveQueueToStorage() {
  await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: forwardQueue });
  console.log("[Storage] Saved queue to storage:", forwardQueue);
}

function loadQueueFromStorage() {
  chrome.storage.local.get(QUEUE_STORAGE_KEY, (result) => {
    forwardQueue = result[QUEUE_STORAGE_KEY] || [];
    console.log("[Storage] Loaded queue from storage:", forwardQueue);
    if (forwardQueue.length > 0) processQueue(); // resume if any pending
  });
}

async function loadProcessedCAsFromStorage() {
  const result = await chrome.storage.local.get(PROCESSED_CAS_KEY);
  processedCAsCache = result[PROCESSED_CAS_KEY] || {};
  console.log("[Storage] Loaded processed CAs:", processedCAsCache);
}

async function saveProcessedCAs(): Promise<void> {
  await chrome.storage.local.set({ [PROCESSED_CAS_KEY]: processedCAsCache });
  console.log("[Storage] Saved processed CAs to storage:", processedCAsCache);
}

async function updateProcessedCA(ca: string, ticker = "") {
  const now = formatISO(new Date());
  if (processedCAsCache[ca]) {
    processedCAsCache[ca].lastSeen = now;
    if (ticker && !processedCAsCache[ca].ticker) {
      processedCAsCache[ca].ticker = ticker;
    }
  } else {
    processedCAsCache[ca] = {
      ticker,
      firstSeen: now,
      lastSeen: now,
    };
  }

  await saveProcessedCAs();
}


async function updateForwardInProgress(
  inProgress: boolean
): Promise<void> {
  await chrome.storage.local.set({ forwardInProgress: inProgress });
  console.log("[Storage] Updated forwardInProgress:", inProgress);
}

async function pruneOldProcessedCAs(): Promise<void> {
  const now = new Date();

  for (const [ca, entry] of Object.entries(processedCAsCache)) {
    const seenDate = parseISO(entry.firstSeen);

    if (!isValid(seenDate)) {
      console.warn(
        `[Prune] Skipping invalid date for CA: ${ca}`,
        entry.firstSeen
      );
      continue;
    }

    const ageInSeconds = differenceInSeconds(now, seenDate);

    if (ageInSeconds > MAX_PROCESSED_AGE) {
      console.log(`[Prune] Removing old CA: ${ca}, age: ${ageInSeconds}s`);
      delete processedCAsCache[ca];
    }
  }

  await saveProcessedCAs();
}

function startTelegramPolling() {
  setInterval(async () => {
    if (!isProcessingQueue) {
      const tabs = await chrome.tabs.query({ url: "*://web.telegram.org/*" });
      if (tabs.length > 0 && forwardQueue.length > 0) {
        console.log(
          "[Polling] Telegram is open. Attempting to process queue..."
        );
        processQueue();
      }
    }
  }, 45_000); // every 30 seconds
}

chrome.runtime.onMessage.addListener((message, _, __) => {
  console.log("[Background] Message received:", message.type);
  if (message.type === "FORWARD_CA") {
    const { ca, ticker } = message.data;

    if (processedCAsCache[ca]) {
      console.log(`[Background] CA already processed: ${ca}`);
      // Mark CA as processed
      updateProcessedCA(ca, ticker).catch((error) => {
        console.error("[Background] Error marking CA as processed:", error);
      });
      return;
    }

    // Mark CA as processed
    updateProcessedCA(ca, ticker).catch((error) => {
      console.error("[Background] Error marking CA as processed:", error);
    });

    forwardQueue.push(message.data);
    saveQueueToStorage(); // Save after push
    console.log("[Queue] Added to queue:", message.data);
    processQueue(); // kick off processing if not already running
  }
});

async function processQueue() {
  console.log("Is Processing Queue:", isProcessingQueue);
  if (isProcessingQueue) {
    console.log("[Queue] Already processing, skipping...");
    return;
  }

  // Check if Telegram is open
  const tabs = await chrome.tabs.query({ url: "*://web.telegram.org/*" });
  if (tabs.length === 0) {
    console.warn("[Queue] Telegram is not open, deferring processing...");
    return;
  }

  isProcessingQueue = true;
  await updateForwardInProgress(true);
  console.log("[Queue] Processing started... ");

  while (forwardQueue.length > 0) {
    const request = forwardQueue[0];
    console.log("[Queue] Processing request:", request);

    try {
      await processForwardedCA(request);

      console.log("[Queue] Request processed, removing from queue...");
      forwardQueue.shift(); // Remove after processing
      await saveQueueToStorage(); // Save updated queue
    } catch (error) {
      console.error("[Queue] Error processing request:", error);
      // Optionally, you can break the loop or handle the error as needed
    }
  }

  isProcessingQueue = false;
  updateForwardInProgress(false);
}


async function processForwardedCA(caMsg: ForwardRequest) {
  const { ca, ticker, chatTitle, timestamp } = caMsg;
  console.log("[Background] Processing forwarded-- Source: ", chatTitle, " CA:", ca, "ticker:", ticker);

  // ⏱️ Ignore messages older than 10 minutes
  const timestampSeconds = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageInSeconds = nowSeconds - timestampSeconds;

  const maxAge = 1800; // 1800 seconds = 30 minutes

  if (ageInSeconds > maxAge) {
    const duration = formatDistanceToNow(timestampSeconds * 1000, {
      addSuffix: true,
    });
    const datetime = formatISO(timestampSeconds * 1000);

    console.log(
      `[CA Message too old]. Source: ${chatTitle} --- Ticker : ${ticker} --- CA: ${ca} --- Datetime: ${datetime} --- Age: ${duration}`
    );
    return;
  }

  const tabs = await chrome.tabs.query({ url: "*://web.telegram.org/*" });
  const telegramTab = tabs[0]; // use the first matching Telegram tab

  if (!telegramTab) {
    console.warn("[Queue] No Telegram tab found.");
    throw new Error("Telegram tab not found");
  }

  if (telegramTab?.id) {
    await chrome.scripting.executeScript({
      target: { tabId: telegramTab.id },
      func: sendToForwardTarget,
      args: [ca, ticker, chatTitle],
    });
    console.log("[Queue] CA forwarding Done.");
  }
}

async function sendToForwardTarget(
  ca: string,
  ticker: string,
  senderChatTitle: string
) {
  console.log("[Send to Forward Target] Called...");
  function getCurrentChatTitle(): string | null {
    const titleEl = document.querySelector(
      '[class*="chat-info"] [class*="title"]'
    );
    return titleEl?.textContent?.trim() || null;
  }

  async function waitForTargetChatLoad(
    expectedTitle: string,
    timeoutMs = 5000
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const titleEl = document.querySelector(
        '[class*="chat-info"] [class*="title"]'
      );
      const currentTitle = titleEl?.textContent?.trim();
      if (currentTitle?.includes(expectedTitle)) return true;
      await new Promise((res) => setTimeout(res, 200));
    }
    return false;
  }

  const originalChatTitle = senderChatTitle ?? getCurrentChatTitle();
  console.log("Original chat title:", originalChatTitle);
  const targetChatName: string = destChatName;

  // Step 1: Navigate to target chat
  const chatListContainer = document.querySelector(".chatlist");
  const chatList = chatListContainer?.querySelectorAll("a.chatlist-chat") || [];

  const targetChat = Array.from(chatList).find((el) => {
    const titleEl = el.querySelector(".user-title");
    return titleEl?.textContent?.trim().includes(targetChatName);
  });

  if (!targetChat) {
    throw new Error(`Target chat [${targetChatName}] not found`);
  }

  targetChat.scrollIntoView({ behavior: "auto", block: "center" });
  targetChat.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  targetChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  const loaded = await waitForTargetChatLoad(targetChatName);
  if (!loaded) {
    throw new Error(`Failed to load target chat [${targetChatName}]`);
  }

  // Step 2: Send the CA message
  const input = document.querySelector(
    '[contenteditable="true"]'
  ) as HTMLElement;
  if (!input) return;

  const messageText = `Source: ${originalChatTitle} \n\nTicker: ${ticker} \n\nCA: ${ca} \n\n`;

  input.focus();
  const pasteEvent = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer(),
  });
  pasteEvent.clipboardData?.setData("text/plain", messageText);
  input.dispatchEvent(pasteEvent);

  const sendButton = document.querySelector(".btn-send");
  if (sendButton instanceof HTMLElement) {
    sendButton.click();
  }

  await new Promise((res) => setTimeout(res, 1000));
  console.log("CA sent successfully to target chat.");

  console.log(
    "[xxxx] Attempting to navigate back to original chat...",
    originalChatTitle
  );

  // Step 3: Navigate back to original chat
  if (originalChatTitle) {
    const originalChat = Array.from(chatList).find((el) => {
      const titleEl = el.querySelector(".user-title");
      return titleEl?.textContent?.trim() === originalChatTitle;
    });

    if (!originalChat) {
      console.log(`Original chat [${originalChatTitle}] not found`);
      return;
    }

    console.log(
      "Simulating click to navigate back to original chat: ",
      originalChatTitle
    );
    originalChat.scrollIntoView({ behavior: "auto", block: "center" });
    originalChat.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    originalChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitForTargetChatLoad(originalChatTitle);
  }
}
