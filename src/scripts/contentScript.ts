// contentScript.ts

import { formatDistanceToNow, formatISO } from "date-fns";
import { ForwardRequest, MessageData, RuntimeSettings } from "./types";

const trojanBotChat: string = "Trojan on Solana - Odysseus";
const extTestReceiverChat = "Ext Test R";
const BUBBLES_GROUP_IDENTIFIER = ".bubbles-group";

let scanUnreadChatsInProgress = false;
let scanUnreadMsgsInProgress = false;
let IS_PROCESSING_QUEUE = false;
let FORWARD_IN_PROGRESS = false;

const CA_QUEUE: ForwardRequest[] = [];

let runtimeSettings: RuntimeSettings | null = {
  watchedChats: [] as string[],
  maxMessageAge: 600, // seconds (default = 10 minutes)
};

const seenMessageIds = new Set<string>();
let chatLoopIndex = 0;

// chrome.runtime.onMessage.addListener(async (message, _, sendResponse) => {
//   console.log("[listener] Message received:`, message.type);
//   if (message.type === "FORWARD_CA") {
//     const { ca, ticker, chatTitle } = message.data;
//     await sendToForwardTarget({
//       ca,
//       ticker,
//       sourceChat: chatTitle,
//       destChat: trojanBotChat,
//     });

//     // await sendToForwardTarget({
//     //   ca,
//     //   ticker,
//     //   sourceChat: chatTitle,
//     //   destChat: extTestReceiverChat,
//     // });

//     sendResponse({ done: true });
//   }
// });

const isBusy = () => {
  if (scanUnreadChatsInProgress) {
    console.log(`[IS BUSY] Scan unread chats in progress`);
  }

  if (scanUnreadMsgsInProgress) {
    console.log(`[IS BUSY] Scan Unread Msgs in Progress`);
  }

  if (IS_PROCESSING_QUEUE) {
    console.log(`[IS BUSY] Processing Queue`);
  }

  if (FORWARD_IN_PROGRESS) {
    console.log(`[IS_BUSY] Forwarding in Progress`);
  }

  // console.log("[IS_BUSY] ", {
  //   scanUnreadChatsInProgress,
  //   scanUnreadMsgsInProgress,
  //   IS_PROCESSING_QUEUE,
  //   FORWARD_IN_PROGRESS
  // })

  return (
    scanUnreadChatsInProgress ||
    scanUnreadMsgsInProgress ||
    IS_PROCESSING_QUEUE ||
    FORWARD_IN_PROGRESS
  );
};
const getBubblesGroup = () => document.querySelector(BUBBLES_GROUP_IDENTIFIER);

async function loadSettings(): Promise<RuntimeSettings> {
  return new Promise((resolve) => {
    if (runtimeSettings) {
      // console.log("Using cached runtime settings: ", runtimeSettings);
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // console.log("Watched chats from local storage:", result.watchedChats);
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
  console.log(`[Processing Message Bubble]`);
  // const isChatWatched = await isWatchedChat();
  // if (!isChatWatched) {
  //   console.log("[Process Message Bubble] Not in watched chat, skipping...");
  //   return;
  // }
  const data = extractMessageData(el);
  if (!data) {
    console.log(`[Message: invalid data]`, data);
    return;
  }

  // ⏱️ Ignore messages older than 10 minutes
  const timestampSeconds = parseInt(data.timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageInSeconds = nowSeconds - timestampSeconds;
  const maxAge = 3 * 60 * 60; // 3 hours

  const duration = formatDistanceToNow(timestampSeconds * 1000, {
    addSuffix: true,
  });
  const datetime = formatISO(timestampSeconds * 1000);

  if (ageInSeconds > maxAge) {
    // console.log(
    //   `[Message too old]. Datetime: ${datetime} --- Age: ${duration} \n\n Data: ${JSON.stringify(
    //     data
    //   )}`
    // );

    console.log(
      `[Message too old]. Datetime: ${datetime} --- Age: ${duration}`
    );
    return; // 600 seconds = 10 minutes
  }

  // seenMessageIds.add(data.mid);
  console.log(`[New Message]. Datetime: ${datetime} --- Age: ${duration}`);
  processMessageData(data);
}

const processQueuedCA = async (caMsg: ForwardRequest) => {
  const { ca, ticker, chatTitle, timestamp } = caMsg;
  console.log(
    `[Process CA] Processing queued CA-- Source: `,
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

  await sendToForwardTarget({
    ca,
    ticker,
    sourceChat: chatTitle,
    destChat: trojanBotChat,
  });

  // await sendToForwardTarget({
  //   ca,
  //   ticker,
  //   sourceChat: chatTitle,
  //   destChat: extTestReceiverChat,
  // });
};

const processCAQueue = async (chatTitle: string) => {
  if (CA_QUEUE.length < 1) {
    console.log(`[Process QUEUE]: Queue Empty.... Exiting`);
    return;
  }

  IS_PROCESSING_QUEUE = true;
  try {
    while (CA_QUEUE.length > 0) {
      const request = CA_QUEUE[0];
      console.log(`[Queue] [${chatTitle}] Processing request:`, request);

      await processQueuedCA(request);

      console.log(`[Queue] Request processed, removing from queue...`);
      CA_QUEUE.shift(); // Remove after processing
    }
  } catch (error) {
    console.error(`[Queue] Error processing request:`, error);
  } finally {
    IS_PROCESSING_QUEUE = false;
  }
};

async function scanUnreadMessages(chatTitle: string) {
  // const isChatWatched = await isWatchedChat();
  // if (!isChatWatched) {
  //   console.log(`[Scan Unread messages] Not in watched chat, skipping...`);
  //   return;
  // }

  scanUnreadMsgsInProgress = true;

  try {
    // if (!getBubblesGroup()) {
    //   scanUnreadMsgsInProgress = false;
    //   console.log(`[Msgs Scanner] No Bubbles Group Found... Exiting`);
    //   return;
    // }

    let prevBubbleCount = 0;

    // Progressive scroll until no new bubbles are loaded
    while (true) {
      const firstUnreadEl = document.querySelector(".bubble.is-first-unread");
      if (!firstUnreadEl) {
        console.log(`[Msgs Scanner] [${chatTitle}] No unread marker found. Exiting scan.`);
        break;
      }

      firstUnreadEl.scrollIntoView({ behavior: "auto", block: "center" });
      await sleep(500); // 500 milliseconds

      const bubbles = Array.from(document.querySelectorAll(".bubble"));
      console.log(
        `[Msgs Scanner] [${chatTitle}] Found bubbles:`,
        bubbles.length
      );
      const firstUnreadIndex = bubbles.indexOf(firstUnreadEl as Element);

      if (firstUnreadIndex === -1) {
        console.log(
          `[Msgs Scanner] [${chatTitle}] Index of unread marker not found. Exiting scan.`
        );
        return;
      }

      const unreadBubbles = bubbles.slice(firstUnreadIndex);

      // Process newly revealed bubbles
      for (const bubble of unreadBubbles) {
        await processMessageBubble(bubble);
      }

      if (unreadBubbles.length === prevBubbleCount) {
        console.log(
          `[Msgs Scanner] [${chatTitle}] No more new unread messages revealed, stopping.`
        );
        break;
      }

      prevBubbleCount = unreadBubbles.length;
      console.log(
        `[Msg Scanner] [${chatTitle}] Scroll to the end of unread bubbles`
      );
      // Scroll just slightly past the last visible bubble
      unreadBubbles.at(-1)?.scrollIntoView({ behavior: "auto", block: "end" });
      await sleep(1000); // sleep for 800 milliseconds
    }
  } finally {
    scanUnreadMsgsInProgress = false;
    console.log(`[Msgs Scanner] [${chatTitle}] Done Scanning`);
  }
}

const processOpenedChat = async (chatTitle: string) => {
  await scanUnreadMessages(chatTitle);
  await processCAQueue(chatTitle);
};

// setInterval(async () => {
//   if (isBusy()) {
//     console.log(`[Monitor] Action in progress, Skipping...`);
//     return;
//   }

//   if (await isForwardInProgress()) {
//     console.log(`Forward in progress,early return`);
//     return;
//   }

//   if (getBubblesGroup()) {
//     console.log(`[Monitor] Chat loaded, Clearing interval...`);
//     const isChatWatched = await isWatchedChat();
//     if (!isChatWatched) {
//       console.log(`[Poll Recent Messages] Not in watched chat, skipping...`);
//       return;
//     }
//     const bubbles = Array.from(document.querySelectorAll(".bubble"));
//     bubbles.forEach((el) => processMessageBubble(el));
//   } else {
//     console.log(`[Monitor] Chat not loaded yet, retrying...`);
//   }
// }, 25_000);

function processMessageData(msg: MessageData) {
  console.log(`[Monitor] Process Message Data Called:`, msg.mid);
  const CA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
  const TICKER_REGEX = /\$[A-Za-z][A-Za-z0-9]{0,19}\b/g;

  const caMatches = msg.text.match(CA_REGEX);
  const tickerMatches = msg.text.match(TICKER_REGEX);

  if (caMatches) {
    const firstCA = caMatches[0];
    const firstTicker = tickerMatches?.[0] || "";

    console.log(`[Monitor] Queueing: CA = ${firstCA}, Ticker = ${firstTicker}`);

    const caData = {
      ca: firstCA,
      ticker: firstTicker,
      chatTitle: msg.chatTitle,
      timestamp: msg.timestamp,
    };

    // chrome.runtime.sendMessage({
    //   type: "QUEUE_CA",
    //   data: caData,
    // });

    CA_QUEUE.push(caData);
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

  console.log(`Expected Chat Title:`, title);
  for (const item of sidebarItems) {
    const label = item
      .querySelector(".user-title .peer-title")
      ?.textContent?.trim();
    const unreadBadge = item.querySelector(".dialog-subtitle-badge-unread");

    if (label === title) {
      if (!unreadBadge) {
        console.log(`[Chat Found] Chat "${title}" has no unread messages.`);
        return false;
      }

      simulateClick(item);

      const chatOpened = await waitFor({
        maxWaitMs: 15_000,
        eachWaitMs: 300,
        logIdentifier: "[Open Chat]",
        condition: async () => {
          const current = getCurrentChatTitle();
          return current === title && !!getBubblesGroup();
        },
      });

      if (chatOpened) {
        console.log(`[Chat Opened] Current chat title:`, title);
        return true;
      }
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

async function waitFor({
  eachWaitMs = 2_000,
  maxWaitMs = 45_000,
  logIdentifier = "",
  condition,
}: {
  maxWaitMs?: number;
  eachWaitMs?: number;
  logIdentifier?: string;
  condition: () => Promise<boolean>;
}) {
  // Wait if a forward is in progress (but no longer than 20 seconds total)
  let waited = 0;

  while ((await condition()) && waited < maxWaitMs) {
    console.log(`${logIdentifier} [Wait For] Forward in progress. Waiting...`);
    await sleep(eachWaitMs); // sleep for 2 second
    waited += eachWaitMs;
  }

  if (waited >= maxWaitMs) {
    console.warn(
      `${logIdentifier} [Wait For] Waited ${
        maxWaitMs / 1000
      } seconds, Done waiting...`
    );
    return false;
  }

  console.log(`${logIdentifier} [Wait For] Condition Met`);
  return true;
}

async function scanAllWatchedChatsWithUnread() {
  (async () => {
    console.log(`[Chat Scanner] Started`);

    if (isBusy()) {
      console.log(`[Chat Scanner] A scan is already in progress... Exiting`);

      return;
    }

    scanUnreadChatsInProgress = true;
    console.log(`[Chat Scanner] No Scan in progress. Beginning New Scan`);

    // Wait if a forward is in progress (but no longer than 45 seconds total)
    // waitFor({
    //   condition: isForwardInProgress,
    //   maxWaitMs: 45_000,
    //   logIdentifier: "[Chat Scanner]",
    // });

    await loadSettings();
    const watchedChats = await getWatchedChats();

    for (const _ in watchedChats) {
      const nextChat = getNextChat(watchedChats);
      const title = nextChat.trim();
      const opened = await openChatByTitle(title);
      if (opened) {
        await processOpenedChat(title);
        break; // Exit after processing the first chat with unread messages
      }
    }

    scanUnreadChatsInProgress = false;

    console.log(`[Chat Scanner]: Scan ended`);
  })().finally(() => setTimeout(scanAllWatchedChatsWithUnread, 15_000));
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

  FORWARD_IN_PROGRESS = true;

  try {
    // await updateForwardInProgress(true);
    console.log(`[Send to Forward Target] Called...`);

    console.log("Before get current chat");

    const originalChatTitle = sourceChat ?? getCurrentChatTitle();
    console.log("After Get Current Chat");
    const targetChatName: string = destChat;

    console.log(
      `Source chat: ${originalChatTitle} -- Dest Chat: ${targetChatName}  -- Timestamp: ${new Date().toISOString()}`
    );

    // Step 1: Navigate to target chat
    const chatListContainer = document.querySelector(".chatlist");
    const chatList =
      chatListContainer?.querySelectorAll("a.chatlist-chat") || [];

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

    await sleep(1000);
    console.log("CA sent successfully to target chat.");

    console.log(
      `[xxxx] Attempting to navigate back to original chat...`,
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
      originalChat.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      originalChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await waitForTargetChatLoad(originalChatTitle);
    }
  } finally {
    FORWARD_IN_PROGRESS = false;
  }
}

// Wait for Telegram UI to be ready
const waitForSidebarLoad = setInterval(() => {
  if (document.querySelector(".chatlist .chatlist-chat")) {
    clearInterval(waitForSidebarLoad);
    console.log(`[Init] Sidebar detected. Starting scanner loop...`);
    scanAllWatchedChatsWithUnread();
  } else {
    console.log(`[Init] Waiting for sidebar...`);
  }
}, 500);
