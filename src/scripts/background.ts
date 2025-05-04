import { formatDistanceToNow, formatISO } from "date-fns";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Telegram CA Monitor installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Telegram CA Monitor started");
});

// background.ts

interface ForwardRequest {
  ca: string;
  chatTitle: string;
  timestamp: string;
  ticker: string;
}

const QUEUE_STORAGE_KEY = "forwardQueue";
let forwardQueue: ForwardRequest[] = [];
let isProcessingQueue = false;

// Load from storage when extension starts
chrome.runtime.onStartup.addListener(loadQueueFromStorage);
chrome.runtime.onInstalled.addListener(loadQueueFromStorage);

// Persist after any modification
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Message received:", message.type);
  if (message.type === "FORWARD_CA") {
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

  console.log("[Queue] Processing started... ");

  while (forwardQueue.length > 0) {
    const request = forwardQueue[0]; // Peek
    console.log("[Queue] Processing request:", request);

    try {
      await processForwardedCA(request);
    } finally {
      // Always remove the item from the queue after processing
      // regardless of success or failure
      console.log("[Queue] Request processed, removing from queue...");
      forwardQueue.shift(); // Remove after processing
      saveQueueToStorage(); // Save updated queue
      // // ✅ Process the next item in queue
      // processQueue();
    }
  }

  isProcessingQueue = false;
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

  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
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

  const messageText = `Source: ${originalChatTitle} \n\nTicker: ${ticker} \n\nCA: ${ca} \n\n`

  input.focus();
  const pasteEvent = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer(),
  });
  pasteEvent.clipboardData?.setData("text/plain", messageText);
  input.dispatchEvent(pasteEvent);

  const sendButton = document.querySelector(".btn-send"); // adjust selector
  // console.log("Send Button:", sendButton);
  if (sendButton instanceof HTMLElement) {
    sendButton.click();
  }

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

    if (originalChat) {
      console.log(
        "Simulating click to navigate back to original chat: ",
        originalChat
      );
      originalChat.scrollIntoView({ behavior: "auto", block: "center" });
      originalChat.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      originalChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await waitForTargetChatLoad(originalChatTitle);
    }
  }
}
