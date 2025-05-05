// background.ts

import { formatDistanceToNow, formatISO } from "date-fns";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Telegram CA Monitor installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Telegram CA Monitor started");
});

interface ForwardRequest {
  ca: string;
  chatTitle: string;
  timestamp: string;
  ticker: string;
}

interface ProcessedCAEntry {
  ticker: string;
  firstSeen: string;
}
type ProcessedCAsMap = Record<string, ProcessedCAEntry>;

const QUEUE_STORAGE_KEY = "forwardQueue";
const PROCESSED_CAS_KEY = "processedCAs";

const MAX_PROCESSED_AGE = 3 * 24 * 60 * 60; // 3 days in seconds

let forwardQueue: ForwardRequest[] = [];
let processedCAsCache: ProcessedCAsMap = {};
let isProcessingQueue = false;

chrome.runtime.onStartup.addListener(() => {
  loadQueueFromStorage();
  loadProcessedCAsFromStorage().then(() => {
    pruneOldProcessedCAs();
  });
});

chrome.runtime.onInstalled.addListener(() => {
  loadQueueFromStorage();
  loadProcessedCAsFromStorage();
});

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

async function markCaAsProcessed(ca: string, ticker: string): Promise<void> {
  processedCAsCache[ca] = {
    ticker,
    firstSeen: new Date().toISOString(),
  };

  await saveProcessedCAs();
}

async function updateForwardInProgress(
  inProgress: boolean
): Promise<void> {
  await chrome.storage.local.set({ forwardInProgress: inProgress });
  console.log("[Storage] Updated forwardInProgress:", inProgress);
}

async function pruneOldProcessedCAs(): Promise<void> {
  const cas = processedCAsCache;
  const now = Math.floor(Date.now() / 1000);
  for (const [ca, entry] of Object.entries(cas)) {
    const timestampMs = Date.parse(entry.firstSeen);
    if (now - timestampMs > MAX_PROCESSED_AGE * 1000) {
      delete cas[ca];
    }
  }
  await saveProcessedCAs();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Message received:", message.type);
  if (message.type === "FORWARD_CA") {
    const { ca, ticker, chatTitle, timestamp } = message.data;

    if (processedCAsCache[ca]) {
      console.log(`[Background] CA already processed: ${ca}`);
      return;
    }

    // Mark CA as processed
    markCaAsProcessed(ca, ticker).catch((error) => {
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

  isProcessingQueue = true;
  await updateForwardInProgress(true);
  console.log("[Queue] Processing started... ");

  while (forwardQueue.length > 0) {
    const request = forwardQueue[0];
    console.log("[Queue] Processing request:", request);

    try {
      await processForwardedCA(request);
    } finally {
      console.log("[Queue] Request processed, removing from queue...");
      forwardQueue.shift(); // Remove after processing
      await saveQueueToStorage(); // Save updated queue
    }
  }

  isProcessingQueue = false;
  updateForwardInProgress(false)
}

async function processForwardedCA(caMsg: ForwardRequest) {
  const { ca, ticker, chatTitle, timestamp } = caMsg;
  console.log("[Background] Processing forwarded CA:", ca, "ticker:", ticker);

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
      `[CA Message too old]. Ticker : ${ticker} --- CA: ${ca} --- Datetime: ${datetime} --- Age: ${duration}`
    );
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (activeTab?.id) {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
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
  const targetChatName = "Ext Test R";

  // Step 1: Navigate to target chat
  const chatListContainer = document.querySelector(".chatlist");
  const chatList = chatListContainer?.querySelectorAll("a.chatlist-chat") || [];

  const targetChat = Array.from(chatList).find((el) => {
    const titleEl = el.querySelector(".user-title");
    return titleEl?.textContent?.trim().includes(targetChatName);
  });

  if (!targetChat) return;

  targetChat.scrollIntoView({ behavior: "auto", block: "center" });
  targetChat.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  targetChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  const loaded = await waitForTargetChatLoad(targetChatName);
  if (!loaded) return;

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
