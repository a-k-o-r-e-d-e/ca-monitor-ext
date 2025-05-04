import { formatDistanceToNow, formatISO } from "date-fns";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Telegram CA Monitor installed");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Telegram CA Monitor started");
});


// background.ts

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Message received:", message);
  if (message.type === "FORWARD_CA") {
    console.log("[Background] Forward CA Message received:");
    const { ca, ticker, chatTitle, timestamp } = message.data;

    processForwardedCA(ca, ticker, chatTitle, timestamp)
  }
});

async function processForwardedCA(ca: string, ticker: string,  chatTitle: string, timestamp: string) {
  console.log("[Background] Processing forwarded CA:", ca, "ticker:", ticker);
  

  // ⏱️ Ignore messages older than 10 minutes
  const timestampSeconds = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageInSeconds = nowSeconds - timestampSeconds;

  const maxAge = 1800; // 1800 seconds = 30 minutes

  if (ageInSeconds > maxAge) {
    const duration = formatDistanceToNow(timestampSeconds * 1000, { addSuffix: true });
    const datetime = formatISO(timestampSeconds * 1000);
    
    console.log(
      `[CA Message too old]. Ticker : ${ticker} --- CA: ${ca} --- Datetime: ${datetime} --- Age: ${duration}`
    );
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (activeTab?.id) {
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: sendToForwardTarget,
        args: [ca, ticker, chatTitle],
      });
    }
  });
}

async function sendToForwardTarget(ca: string, ticker: string, senderChatTitle: string) {
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

  const messageText = ticker ? `${ticker} → ${ca}` : ca;

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

    console.log("[xxxx] Attempting to navigate back to original chat...", originalChatTitle);

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
      console.log("Simulating click to navigate back to original chat: ", originalChat);
      originalChat.scrollIntoView({ behavior: "auto", block: "center" });
      originalChat.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      originalChat.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await waitForTargetChatLoad(originalChatTitle);
    }
  }
}
