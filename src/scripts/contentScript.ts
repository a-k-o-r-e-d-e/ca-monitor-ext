// contentScript.ts

import { formatDistanceToNow, formatISO } from "date-fns";

const trojanBotChat: string = "Trojan on Solana - Odysseus";
const extTestReceiverChat = "Ext Test R";

chrome.runtime.onMessage.addListener(async (message, _, sendResponse) => {
  console.log("[listener] Message received:", message.type);
  if (message.type === "FORWARD_CA") {
    const { ca, ticker, chatTitle } = message.data;
    await sendToForwardTarget({
      ca,
      ticker,
      sourceChat: chatTitle,
      destChat: trojanBotChat,
    });

    await sendToForwardTarget({
      ca,
      ticker,
      sourceChat: chatTitle,
      destChat: extTestReceiverChat,
    });

    sendResponse({ done: true });
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type === "START_SCAN") {
    console.log(
      `[Content Script] START_SCAN received at ${new Date().toISOString()}`
    );
    scanAllWatchedChatsWithUnread();
  }
});

interface MessageData {
  mid: string;
  timestamp: string;
  text: string;
  chatTitle: string;
}

interface RuntimeSettings {
  watchedChats: string[];
  maxMessageAge: number; // in seconds
}

let runtimeSettings: RuntimeSettings | null = {
  watchedChats: [] as string[],
  maxMessageAge: 600, // seconds (default = 10 minutes)
};

const seenMessageIds = new Set<string>();
let chatLoopIndex = 0;

async function loadSettings(): Promise<RuntimeSettings> {
  return new Promise((resolve) => {
    if (runtimeSettings) {
      console.log("Using cached runtime settings: ", runtimeSettings);
      resolve(runtimeSettings);
    }

    chrome.storage.local.get(["watchedChats", "maxMessageAge"], (result) => {
      runtimeSettings = {
        watchedChats: result.watchedChats || [],
        maxMessageAge: (result.maxMessageAge || 10) * 60, // minutes → seconds
      };
      resolve(runtimeSettings);
    });
  });
}

async function getWatchedChats(): Promise<string[]> {
  console.log("Getting watched chats...");
  const settings = await loadSettings();
  if (settings.watchedChats.length > 0) {
    return settings.watchedChats;
  }

  console.log("No watched chats in settings, falling back to local storage...");

  // Fallback to local storage if no watched chats in settings
  // This is useful for testing or if the settings are not set yet
  return new Promise((resolve) => {
    chrome.storage.local.get("watchedChats", (result) => {
      console.log("Watched chats from local storage:", result.watchedChats);
      resolve(result.watchedChats || []);
    });
  });
}

function getCurrentChatTitle(): string | null {
  const titleEl = document.querySelector(
    '[class*="chat-info"] [class*="title"]'
  );
  return titleEl?.textContent?.trim() || null;
}

async function isWatchedChat(): Promise<boolean> {
  const currentTitle = getCurrentChatTitle();
  console.log("Current chat title:", currentTitle);
  if (!currentTitle) return false;

  const watched = await getWatchedChats();
  console.log("Watched chats:", watched);
  return watched.includes(currentTitle);
}

function extractMessageData(el: Element): MessageData | null {
  const mid = el.getAttribute("data-mid");
  const timestamp = el.getAttribute("data-timestamp");
  const translatableTextEl = el.querySelector(".message .translatable-message");
  const textEl = translatableTextEl ?? el.querySelector(".message");
  const chatTitle = getCurrentChatTitle() || "";

  if (!mid || !timestamp || !textEl) return null;

  const text = textEl.textContent?.trim() || "";
  return { mid, timestamp, text, chatTitle };
}

async function processMessageBubble(el: Element) {
  console.log("[Processing Message Bubble]");
  // const isChatWatched = await isWatchedChat();
  // if (!isChatWatched) {
  //   console.log("[Process Message Bubble] Not in watched chat, skipping...");
  //   return;
  // }
  const data = extractMessageData(el);
  if (!data) {
    console.log("[Message: invalid data]", data);
    return;
  }

  // ⏱️ Ignore messages older than 10 minutes
  const timestampSeconds = parseInt(data.timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageInSeconds = nowSeconds - timestampSeconds;
  const maxAge = 3 * 60 * 60; // 3 hours

  if (ageInSeconds > maxAge) {
    const duration = formatDistanceToNow(timestampSeconds * 1000, {
      addSuffix: true,
    });
    const datetime = formatISO(timestampSeconds * 1000);

    console.log(
      `[Message too old]. Datetime: ${datetime} --- Age: ${duration} \n\n Data: ${JSON.stringify(
        data
      )}`
    );
    return; // 600 seconds = 10 minutes
  }

  // seenMessageIds.add(data.mid);
  console.log("[New Message]", data);
  processMessageData(data);
}

async function scanUnreadMessages() {
  // const isChatWatched = await isWatchedChat();
  // if (!isChatWatched) {
  //   console.log("[Scan Unread messages] Not in watched chat, skipping...");
  //   return;
  // }

  const container = document.querySelector(".bubbles-group");
  if (!container) return;

  let prevBubbleCount = 0;

  // Progressive scroll until no new bubbles are loaded
  while (true) {
    const firstUnreadEl = document.querySelector(".bubble.is-first-unread");
    if (!firstUnreadEl) {
      console.log("[Scan] No unread marker found. Exiting scan.");
      break;
    }

    firstUnreadEl.scrollIntoView({ behavior: "auto", block: "center" });
    await new Promise((res) => setTimeout(res, 300));

    const bubbles = Array.from(document.querySelectorAll(".bubble"));
    console.log("[Scan] Found bubbles:", bubbles.length);
    const firstUnreadIndex = bubbles.indexOf(firstUnreadEl as Element);

    if (firstUnreadIndex === -1) {
      console.log("[Scan] Index of unread marker not found. Exiting scan.");
      return;
    }

    const unreadBubbles = bubbles.slice(firstUnreadIndex);

    // Process newly revealed bubbles
    for (const bubble of unreadBubbles) {
      await processMessageBubble(bubble);
    }

    if (unreadBubbles.length === prevBubbleCount) {
      console.log("[Scan] No more new unread messages revealed, stopping.");
      break;
    }

    prevBubbleCount = unreadBubbles.length;

    // Scroll just slightly past the last visible bubble
    unreadBubbles.at(-1)?.scrollIntoView({ behavior: "auto", block: "end" });
    await new Promise((res) => setTimeout(res, 800));
  }
}

setInterval(async () => {
  if (await isForwardInProgress()) {
    console.log("Forard in progress,early return");
    return;
  }

  if (document.querySelector(".bubbles-group")) {
    console.log("[Monitor] Chat loaded, Clearing interval...");
    const isChatWatched = await isWatchedChat();
    if (!isChatWatched) {
      console.log("[Poll Recent Messages] Not in watched chat, skipping...");
      return;
    }
    const bubbles = Array.from(document.querySelectorAll(".bubble"));
    bubbles.forEach((el) => processMessageBubble(el));
  } else {
    console.log("[Monitor] Chat not loaded yet, retrying...");
  }
}, 25000);

function processMessageData(msg: MessageData) {
  console.log("[Monitor] Process Message Data Called:", msg.mid);
  const CA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
  const TICKER_REGEX = /\$[A-Za-z][A-Za-z0-9]{0,19}\b/g;

  const caMatches = msg.text.match(CA_REGEX);
  const tickerMatches = msg.text.match(TICKER_REGEX);

  if (caMatches) {
    const firstCA = caMatches[0];
    const firstTicker = tickerMatches?.[0] || "";

    console.log(`[Monitor] Queueing: CA = ${firstCA}, Ticker = ${firstTicker}`);

    chrome.runtime.sendMessage({
      type: "QUEUE_CA",
      data: {
        ca: firstCA,
        ticker: firstTicker,
        chatTitle: msg.chatTitle,
        timestamp: msg.timestamp,
      },
    });
  }
}

function simulateClick(element: Element) {
  element.scrollIntoView({ behavior: "auto", block: "center" });
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function openChatByTitle(title: string): Promise<boolean> {
  const sidebarItems = Array.from(
    document.querySelectorAll(".chatlist .chatlist-chat")
  );

  // console.log("Sidebar items:", sidebarItems);

  console.log("Expected Chat Title:", title);
  for (const item of sidebarItems) {
    const label = item
      .querySelector(".user-title .peer-title")
      ?.textContent?.trim();
    const unreadBadge = item.querySelector(".dialog-subtitle-badge-unread");

    if (label === title) {
      if (unreadBadge) {
        simulateClick(item);

        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 300));
          const current = getCurrentChatTitle();

          if (current === title) {
            console.log("[Chat Opened] Current chat title:", current);
            return true;
          }
        }
      }

      console.log(`[Chat Found] Chat "${title}" has no unread messages.`);
      return false;
    }
  }

  console.log(`[Chat Not Found] Chat "${title}" not found in sidebar.`);
  return false;
}

function getNextChat(watchedChats: string[] = []): string {
  const nextIndex = (chatLoopIndex + 1) % watchedChats.length;
  const nextChat = watchedChats[nextIndex];
  chatLoopIndex = nextIndex;
  return nextChat;
}

async function isForwardInProgress(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get("forwardInProgress");
    console.log("Result InPogress: ", result);
    return result.forwardInProgress === true;
  } catch (error) {
    console.error("Error checking forwardInProgress:", error);
    return false;
  }
}

async function scanAllWatchedChatsWithUnread() {
  // Wait if a forward is in progress (but no longer than 20 seconds total)
  let waited = 0;
  const maxWait = 30000; // 20 seconds

  while ((await isForwardInProgress()) && waited < maxWait) {
    console.log("[Chat Scanner] Forward in progress. Waiting...");
    await new Promise((res) => setTimeout(res, 1000));
    waited += 2000;
  }

  if (waited >= maxWait) {
    console.warn("[Chat Scanner] Waited 20 seconds, continuing anyway...");
  }

  await loadSettings();
  const watchedChats = await getWatchedChats();

  for (const _ in watchedChats) {
    const nextChat = getNextChat(watchedChats);
    const title = nextChat.trim();
    const opened = await openChatByTitle(title);
    if (opened) {
      await scanUnreadMessages();
      break; // Exit after processing the first chat with unread messages
    }
  }

  setTimeout(scanAllWatchedChatsWithUnread, 15000);
}

async function sendToForwardTarget({
  destChat,
  ca,
  ticker,
  sourceChat,
}: {
  destChat: string;
  ca: string;
  ticker: string;
  sourceChat: string;
}) {
  // await updateForwardInProgress(true);
  console.log("[Send to Forward Target] Called...");
  console.log("[Send to Forward Target] Another Call Called...");
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

  console.log("Before get current chat");

  const originalChatTitle = sourceChat ?? getCurrentChatTitle();
  console.log("After Get Current Chat");
  const targetChatName: string = destChat;

  console.log(
    `Source chat: ${originalChatTitle} -- Dest Chat: ${targetChatName}  -- Timestamp: ${new Date().toISOString()}`
  );

  // Step 1: Navigate to target chat
  const chatListContainer = document.querySelector(".chatlist");
  const chatList = chatListContainer?.querySelectorAll("a.chatlist-chat") || [];

  const targetChat = Array.from(chatList).find((el) => {
    const titleEl = el.querySelector(".user-title");
    return titleEl?.textContent?.trim().includes(targetChatName);
  });

  if (!targetChat) {
    const errMsg = `Target chat [${targetChatName}] not found -- Timestamp: ${new Date().toISOString()}`;
    console.log(errMsg);
    throw new Error(errMsg);
  }

  console.log(`Chat found -- Timestamp: ${new Date().toISOString()}`);

  targetChat.scrollIntoView({ behavior: "auto", block: "center" });
  targetChat.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  targetChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  const loaded = await waitForTargetChatLoad(targetChatName);
  if (!loaded) {
    const errMsg = `Failed to load target chat [${targetChatName}] -- Timestamp: ${new Date().toISOString()}`;
    console.log(errMsg);
    throw new Error(errMsg);
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

// Wait for Telegram UI to be ready
const waitForSidebarLoad = setInterval(() => {
  if (document.querySelector(".chatlist .chatlist-chat")) {
    clearInterval(waitForSidebarLoad);
    console.log("[Init] Sidebar detected. Starting scanner loop...");
    scanAllWatchedChatsWithUnread();
  } else {
    console.log("[Init] Waiting for sidebar...");
  }
}, 500);
