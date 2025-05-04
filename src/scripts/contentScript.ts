// contentScript.ts

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
let forwardInProgress = false;

chrome.runtime.onMessage.addListener((message) => {
  console.log("[ContentScript] Message received:", message.type);
  if (message.type === "SET_FORWARD_IN_PROGRESS") {
    forwardInProgress = message.data.inProgress;
    console.log("[ContentScript] Forwarding state updated:", forwardInProgress);
  }
});

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
  console.log("[Processing Message Bubble]", el);
  const isChatWatched = await isWatchedChat();
  if (!isChatWatched) {
    console.log("[Process Message Bubble] Not in watched chat, skipping...");
    return;
  }
  const data = extractMessageData(el);
  if (!data || seenMessageIds.has(data.mid)) {
    console.log("[Message already seen or invalid data]", data);
    return;
  }

  // ⏱️ Ignore messages older than 10 minutes
  const timestampSeconds = parseInt(data.timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageInSeconds = nowSeconds - timestampSeconds;
  const maxAge = (await loadSettings()).maxMessageAge;

  // if (ageInSeconds > maxAge) {
  //   console.log("[Message too old]", data);
  //   return; // 600 seconds = 10 minutes
  // }

  seenMessageIds.add(data.mid);
  console.log("[New Message]", data);
  processMessageData(data);
}

function scrollChatContainerBy(pixels: number) {
  console.log
  const container = document.querySelector(".bubbles-group");
  if (container) container.scrollBy(0, pixels);
}

async function scanUnreadMessagesInChunks(maxBatches = 10) {
  const isChatWatched = await isWatchedChat();
  if (!isChatWatched) {
    console.log("[Scan Unread messages] Not in watched chat, skipping...");
    return;
  }

  const container = document.querySelector(".bubbles-group");
  if (!container) return;

  for (let i = 0; i < maxBatches; i++) {
    const firstUnreadEl = document.querySelector(".bubble.is-first-unread");
    if (!firstUnreadEl) {
      console.log("[Scan Chunk] No unread marker found.");
      break;
    }

    firstUnreadEl.scrollIntoView({ behavior: "auto", block: "center" });
    await new Promise((res) => setTimeout(res, 300));

    const allBubbles = Array.from(container.querySelectorAll(".bubble"));
    const index = allBubbles.indexOf(firstUnreadEl as Element);
    if (index === -1) break;

    const unreadBubbles = allBubbles.slice(index, index + 10);
    for (const bubble of unreadBubbles) {
      await processMessageBubble(bubble);
    }

    scrollChatContainerBy(300);
    await new Promise((res) => setTimeout(res, 1000));
  }
}

function observeNewMessages() {
  const container = document.querySelector(".bubbles-group");
  if (!container) return;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(async (node) => {
        if (node instanceof HTMLElement && node.classList.contains("bubble")) {
          const isChatWatched = await isWatchedChat();
          if (!isChatWatched) {
            console.log(
              "[New Message Mutation] Not in watched chat, skipping..."
            );
            return;
          }
          console.log("[New Message Mutation] New message detected:", node);
          processMessageBubble(node);
        }
      });
    }
  });

  observer.observe(container, { childList: true, subtree: true });
}

async function pollRecentMessages() {
  const isChatWatched = await isWatchedChat();
  if (!isChatWatched) {
    console.log("[Poll Recent Messages] Not in watched chat, skipping...");
    return;
  }
  const bubbles = Array.from(document.querySelectorAll(".bubble"));
  bubbles.forEach((el) => processMessageBubble(el));
}

async function initTelegramMessageMonitor() {
  scanUnreadMessagesInChunks();
  observeNewMessages();
}

async function startIfWatchedChat() {
  console.log("[Monitor] Starting Telegram message monitor...");
  await loadSettings();

  const isChatWatched = await isWatchedChat();
  if (!isChatWatched) {
    console.log("[startIfWatchedChat] Chat not watched, skipping...");
    return;
  }

  console.log(
    "[startIfWatchedChat] Chat is in watched list, starting monitor..."
  );
  initTelegramMessageMonitor();

  setInterval(async () => {
    console.log("[Monitor] Forward in progress:", forwardInProgress);
    if (forwardInProgress) {
      console.log("[Monitor] Forward in progress, skipping polling...");
      return;
    }

    console.log("[Monitor] Polling recent messages...");
    const isChatWatched = await isWatchedChat();
    if (!isChatWatched) {
      console.log("[Poll Interval] Not in watched chat, skipping...");
      return;
    }

    pollRecentMessages();
  }, 25000);
}

const waitForChatLoad = setInterval(() => {
  console.log("[Monitor] Waiting for chat to load...");
  if (document.querySelector(".bubbles-group")) {
    clearInterval(waitForChatLoad);
    console.log("[Monitor] Chat loaded, Clearing interval...");
    startIfWatchedChat();
  } else {
    console.log("[Monitor] Chat not loaded yet, retrying...");
  }
}, 500);

function processMessageData(msg: MessageData) {
  console.log("[Monitor] Process Message Data Called:", msg.mid);
  const CA_REGEX = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const TICKER_REGEX = /\$[A-Za-z][A-Za-z0-9]{0,19}\b/g;

  const caMatches = msg.text.match(CA_REGEX);
  const tickerMatches = msg.text.match(TICKER_REGEX);

  if (caMatches) {
    const firstCA = caMatches[0];
    const firstTicker = tickerMatches?.[0] || "";

    console.log(
      `[Monitor] Forwarding: CA = ${firstCA}, Ticker = ${firstTicker}`
    );

    chrome.runtime.sendMessage({
      type: "FORWARD_CA",
      data: {
        ca: firstCA,
        ticker: firstTicker,
        chatTitle: msg.chatTitle,
        timestamp: msg.timestamp,
      },
    });
  }
}
