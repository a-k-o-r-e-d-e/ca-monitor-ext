// background.ts

import {
  differenceInSeconds,
  formatDistanceToNow,
  formatISO,
  isValid,
  parseISO,
} from "date-fns";
import { ForwardRequest, ProcessedCAsMap } from "./types";

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

// chrome.runtime.onInstalled.addListener(async () => {
//   const tabs = await chrome.tabs.query({ url: "*://web.telegram.org/*" });
//   for (const tab of tabs) {
//     if (tab.id) {
//       chrome.scripting.executeScript({
//         target: { tabId: tab.id },
//         func: () => {
//           window.postMessage({ type: "START_SCAN" }, "*");
//         },
//       });
//     }
//   }
// });



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

async function updateForwardInProgress(inProgress: boolean): Promise<void> {
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
        await processQueue();
      }
    }
  }, 45_000); // every 30 seconds
}

chrome.runtime.onMessage.addListener(async (message, _, __) => {
  console.log("[Background] Message received:", message.type);
  if (message.type === "QUEUE_CA") {
    const { ca, ticker } = message.data;

    if (processedCAsCache[ca]) {
      console.log(`[Background] CA already processed: ${ca}`);
      // Mark CA as processed
      await updateProcessedCA(ca, ticker).catch((error) => {
        console.error("[Background] Error marking CA as processed:", error);
      });
      return;
    }

    // Mark CA as processed
    await updateProcessedCA(ca, ticker).catch((error) => {
      console.error("[Background] Error marking CA as processed:", error);
    });

    forwardQueue.push(message.data);
    await saveQueueToStorage(); // Save after push
    console.log("[Queue] Added to queue:", message.data);
    await processQueue(); // kick off processing if not already running
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
      await processQueuedCA(request);

      console.log("[Queue] Request processed, removing from queue...");
      forwardQueue.shift(); // Remove after processing
      await saveQueueToStorage(); // Save updated queue
    } catch (error) {
      console.error("[Queue] Error processing request:", error);
      // Optionally, you can break the loop or handle the error as needed
    }
  }

  isProcessingQueue = false;
  await updateForwardInProgress(false);
}

async function processQueuedCA(caMsg: ForwardRequest) {
  const { ca, ticker, chatTitle, timestamp } = caMsg;
  console.log(
    "[Background] Processing queued CA-- Source: ",
    chatTitle,
    " CA:",
    ca,
    "ticker:",
    ticker
  );

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

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

  const telegramTab = tabs[0]; // use the first matching Telegram tab

  if (!telegramTab) {
    console.warn("[Queue] No Telegram tab found.");
    throw new Error("Telegram tab not found");
  }
  const response = await chrome.tabs.sendMessage(telegramTab.id!, {
    type: "FORWARD_CA",
    data: {
      ca: ca,
      ticker: ticker,
      chatTitle: chatTitle,
      // timestamp: msg.timestamp,
    },
  });

  console.log("Response:: ", response);

  console.log("Gibberish");
}
