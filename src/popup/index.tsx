import React, { useEffect, useState } from "react";

export default function App() {
  const [chats, setChats] = useState<string[]>([]);
  const [newChat, setNewChat] = useState("");

  useEffect(() => {
    if (chrome?.storage?.local) {
      chrome.storage.local.get(["watchedChats"], (result) => {
        if (result.watchedChats) setChats(result.watchedChats);
      });
    }
  }, []);

  const saveChats = (updatedChats: string[]) => {
    setChats(updatedChats);

    chrome.storage.local.set({ watchedChats: updatedChats });
  };

  const addChat = () => {
    const trimmed = newChat.trim();
    if (trimmed && !chats.includes(trimmed)) {
      const updated = [...chats, trimmed];
      saveChats(updated);
      setNewChat("");
    }
  };

  const removeChat = (chat: string) => {
    const updated = chats.filter((c) => c !== chat);
    saveChats(updated);
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Telegram CA Monitor</h1>

      <div>
        <label className="block text-sm font-medium">Add a chat/channel</label>
        <div className="flex gap-2 mt-1">
          <input
            className="flex-grow border p-2 rounded"
            value={newChat}
            onChange={(e) => setNewChat(e.target.value)}
            placeholder="Enter chat title"
          />
          <button
            className="bg-green-600 text-white px-3 py-2 rounded"
            onClick={addChat}
          >
            Add
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium">Chats to watch</label>
        <ul className="space-y-1 mt-2">
          {chats.map((chat, idx) => (
            <li
              key={idx}
              className="flex justify-between items-center border p-2 rounded"
            >
              <span>{chat}</span>
              <button
                className="bg-red-500 text-white px-2 py-1 rounded text-sm"
                onClick={() => removeChat(chat)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
