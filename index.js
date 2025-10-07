// bot-panel-fixed.js
import fs from "fs";
import express from "express";
import * as ws3fca from "ws3-fca"; // import defensively for both CJS & ESM

// Resolve the actual login function whether the module exported default or module itself
const login = (ws3fca && (ws3fca.default || ws3fca)) ;

if (typeof login !== "function") {
  console.error("❌ The 'ws3-fca' module did not export a function named login.");
  console.error("Check the package docs or try `npm i ws3-fca` and confirm export style.");
  // Still continue so the rest of the file doesn't crash at import time.
}

const OWNER_UIDS = ["100070465039177"];
let rkbInterval = null;
let stopRequested = false;
const lockedGroupNames = {};
let mediaLoopInterval = null;
let lastMedia = null;
let targetUID = null;
let stickerInterval = null;
let stickerLoopActive = false;

const readLinesFile = (path) => {
  try {
    return fs.existsSync(path) ? fs.readFileSync(path, "utf8").split("\n").map(x => x.trim()).filter(Boolean) : [];
  } catch (e) {
    console.error(`❌ Error reading ${path}:`, e.message);
    return [];
  }
};

const friendUIDs = readLinesFile("Friend.txt");
const targetUIDs = readLinesFile("Target.txt");

const messageQueues = {};
const queueRunning = {};

const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("<h2>Messenger Bot Running</h2>"));
app.listen(PORT, () => console.log(`🌐 Log server: http://localhost:${PORT}`));

// global error handlers (keep them informative)
process.on("uncaughtException", (err) => {
  console.error("❗ Uncaught Exception:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❗ Unhandled Rejection:", reason && reason.stack ? reason.stack : reason);
});

// Validate appstate.json early so login doesn't fail with cryptic error on Render
if (!fs.existsSync("appstate.json")) {
  console.error("❌ appstate.json not found in project root. Create or upload it before starting the bot.");
}

// If login isn't a function, we don't attempt to call it (prevents crash)
if (typeof login !== "function") {
  console.error("❌ Aborting login because 'login' is not a function.");
  // you can still keep process up so Render doesn't crash completely, but bot won't run
} else {
  // call login (keeps original callback style used earlier)
  login({ appState: fs.existsSync("appstate.json") ? JSON.parse(fs.readFileSync("appstate.json", "utf8")) : null }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);

    // defensive checks for api
    if (!api) {
      console.error("❌ Login succeeded but returned no api object.");
      return;
    }

    try {
      // if api supports setOptions
      if (typeof api.setOptions === "function") api.setOptions({ listenEvents: true });

      // If api has getCurrentUserID function add to owners
      if (typeof api.getCurrentUserID === "function") {
        try {
          const me = api.getCurrentUserID();
          if (me) OWNER_UIDS.push(me);
        } catch (e) {
          console.warn("⚠️ Couldn't get current user id:", e.message);
        }
      }

      console.log("✅ Bot logged in and running...");

      // message/event listener: adapt depending on library event style
      const listenerFn = async (errEvt, event) => {
        try {
          // compatibility: some libs use (err, event) style, some pass single event object
          let eventObj = event;
          if (!eventObj && errEvt && typeof errEvt === "object" && errEvt.threadID) {
            eventObj = errEvt;
            errEvt = null;
          }
          if (errEvt) {
            // if there's an error object, log and skip
            console.error("Listener error:", errEvt);
            return;
          }
          if (!eventObj) return;

          const { threadID, senderID, body, messageID, type, logMessageType, logMessageData, messageReply, attachments } = eventObj;

          const enqueueMessage = (uid, threadID, messageID, apiLocal) => {
            if (!messageQueues[uid]) messageQueues[uid] = [];
            messageQueues[uid].push({ threadID, messageID });

            if (queueRunning[uid]) return;
            queueRunning[uid] = true;

            const lines = readLinesFile("np.txt");
            let index = 0;

            const processQueue = async () => {
              if (!messageQueues[uid].length) {
                queueRunning[uid] = false;
                return;
              }
              const msg = messageQueues[uid].shift();
              const randomLine = lines.length ? lines[Math.floor(Math.random() * lines.length)] : " ";
              if (typeof apiLocal.sendMessage === "function") {
                try {
                  await apiLocal.sendMessage(randomLine, msg.threadID, msg.messageID);
                } catch (e) {
                  console.error("⚠️ sendMessage failed in queue:", e.message || e);
                }
              }
              setTimeout(processQueue, 10000);
            };

            processQueue();
          };

          // auto-enqueue for target UIDs
          if (fs.existsSync("np.txt") && (targetUIDs.includes(senderID) || senderID === targetUID)) {
            enqueueMessage(senderID, threadID, messageID, api);
          }

          // handle group name change events
          if (type === "event" && logMessageType === "log:thread-name" && logMessageData) {
            const currentName = logMessageData.name;
            const lockedName = lockedGroupNames[threadID];
            if (lockedName && currentName !== lockedName) {
              try {
                if (typeof api.setTitle === "function") {
                  await api.setTitle(lockedName, threadID);
                }
                if (typeof api.sendMessage === "function") {
                  api.sendMessage(`Group name restored to "${lockedName}"`, threadID);
                }
              } catch (e) {
                console.error("❌ Error reverting group name:", e.message || e);
              }
            }
            return;
          }

          if (!body) return;
          const lowerBody = body.toLowerCase();

          const badNames = ["aman", "dark", "lord", "king", "lordx", "devils", "legend"];
          const triggers = ["rkb", "bhen", "maa", "rndi", "chut", "randi", "madhrchodh", "mc", "bc", "didi", "tmkc"];

          if (
            badNames.some(n => lowerBody.includes(n)) &&
            triggers.some(w => lowerBody.includes(w)) &&
            !friendUIDs.includes(senderID)
          ) {
            return api.sendMessage(
              "teri ma Rndi hai tu msg mt kr sb chodege teri ma  ko byy🙂 ss Lekr story Lga by",
              threadID,
              messageID
            );
          }

          if (!OWNER_UIDS.includes(senderID)) return;

          const args = body.trim().split(" ");
          const cmd = args[0].toLowerCase();
          const input = args.slice(1).join(" ");

          // COMMANDS: keep behavior same as your original
          if (cmd === "/allname") {
            try {
              const info = typeof api.getThreadInfo === "function" ? await api.getThreadInfo(threadID) : null;
              const members = info && info.participantIDs ? info.participantIDs : [];
              api.sendMessage(`🛠  ${members.length} ' nicknames...`, threadID);
              for (const uid of members) {
                try {
                  if (typeof api.changeNickname === "function") {
                    await api.changeNickname(input, threadID, uid);
                  }
                  console.log(`✅ Nickname changed for UID: ${uid}`);
                  await new Promise(res => setTimeout(res, 20000));
                } catch (e) {
                  console.log(`⚠️ Failed for ${uid}:`, e.message || e);
                }
              }
              api.sendMessage("ye gribh ka bcha to Rone Lga bkL", threadID);
            } catch (e) {
              console.error("❌ Error in /allname:", e);
              api.sendMessage("badh me kLpauga", threadID);
            }
          }

          else if (cmd === "/groupname") {
            try {
              if (typeof api.setTitle === "function") await api.setTitle(input, threadID);
              api.sendMessage(`📝 Group name changed to: ${input}`, threadID);
            } catch (e) {
              api.sendMessage(" klpoo🤣 rkb", threadID);
            }
          }

          else if (cmd === "/lockgroupname") {
            if (!input) return api.sendMessage("name de 🤣 gc ke Liye", threadID);
            try {
              if (typeof api.setTitle === "function") await api.setTitle(input, threadID);
              lockedGroupNames[threadID] = input;
              api.sendMessage(`🔒 Group name locked as "${input}"`, threadID);
            } catch (e) {
              api.sendMessage("❌ Locking failed.", threadID);
            }
          }

          else if (cmd === "/unlockgroupname") {
            delete lockedGroupNames[threadID];
            api.sendMessage("🔓 Group name unlocked.", threadID);
          }

          else if (cmd === "/uid") {
            api.sendMessage(`🆔 Group ID: ${threadID}`, threadID);
          }

          else if (cmd === "/exit") {
            try {
              if (typeof api.removeUserFromGroup === "function") {
                await api.removeUserFromGroup(api.getCurrentUserID(), threadID);
              } else {
                throw new Error("removeUserFromGroup not supported by api");
              }
            } catch {
              api.sendMessage("❌ Can't leave group.", threadID);
            }
          }

          else if (cmd === "/rkb") {
            if (!fs.existsSync("np.txt")) return api.sendMessage("konsa gaLi du rkb ko", threadID);
            const name = input.trim();
            const lines = readLinesFile("np.txt");
            stopRequested = false;

            if (rkbInterval) clearInterval(rkbInterval);
            let index = 0;

            rkbInterval = setInterval(() => {
              if (index >= lines.length || stopRequested) {
                clearInterval(rkbInterval);
                rkbInterval = null;
                return;
              }
              api.sendMessage(`${name} ${lines[index]}`, threadID);
              index++;
            }, 40000);

            api.sendMessage(`sex hogya bche 🤣rkb ${name}`, threadID);
          }

          else if (cmd === "/stop") {
            stopRequested = true;
            if (rkbInterval) {
              clearInterval(rkbInterval);
              rkbInterval = null;
              api.sendMessage("chud gaye bche🤣", threadID);
            } else {
              api.sendMessage("konsa gaLi du sale ko🤣 rkb tha", threadID);
            }
          }

          else if (cmd === "/photo") {
            api.sendMessage("📸 Send a photo or video within 1 minute...", threadID);

            const handleMedia = async (mediaEvent) => {
              // Some libs call event with different shapes; guard carefully
              const me = mediaEvent && mediaEvent.threadID ? mediaEvent : null;
              if (
                me &&
                me.threadID === threadID &&
                me.attachments &&
                me.attachments.length > 0
              ) {
                lastMedia = {
                  attachments: me.attachments,
                  threadID: me.threadID
                };

                api.sendMessage("✅ Photo/video received. Will resend every 30 seconds.", threadID);

                if (mediaLoopInterval) clearInterval(mediaLoopInterval);
                mediaLoopInterval = setInterval(() => {
                  if (lastMedia) {
                    api.sendMessage({ attachment: lastMedia.attachments }, lastMedia.threadID);
                  }
                }, 30000);

                // best-effort remove listener — different libs use different remove methods
                if (typeof api.removeListener === "function") {
                  try { api.removeListener("message", handleMedia); } catch {}
                }
              }
            };

            if (typeof api.on === "function") {
              api.on("message", handleMedia);
            } else {
              api.sendMessage("⚠️ Media listener not supported by API.", threadID);
            }
          }

          else if (cmd === "/stopphoto") {
            if (mediaLoopInterval) {
              clearInterval(mediaLoopInterval);
              mediaLoopInterval = null;
              lastMedia = null;
              api.sendMessage("chud gaye sb.", threadID);
            } else {
              api.sendMessage("🤣ro sale chnar", threadID);
            }
          }

          else if (cmd === "/forward") {
            try {
              const info = typeof api.getThreadInfo === "function" ? await api.getThreadInfo(threadID) : null;
              const members = info && info.participantIDs ? info.participantIDs : [];

              const msgInfo = messageReply || eventObj.messageReply;
              if (!msgInfo) return api.sendMessage("❌ Kisi message ko reply karo bhai", threadID);

              for (const uid of members) {
                if (uid !== api.getCurrentUserID()) {
                  try {
                    await api.sendMessage({
                      body: msgInfo.body || "",
                      attachment: msgInfo.attachments || []
                    }, uid);
                  } catch (e) {
                    console.log(`⚠️ Can't send to ${uid}:`, e.message || e);
                  }
                  await new Promise(res => setTimeout(res, 2000));
                }
              }

              api.sendMessage("📨 Forwarding complete.", threadID);
            } catch (e) {
              console.error("❌ Error in /forward:", e.message || e);
              api.sendMessage("❌ Error bhai, check logs", threadID);
            }
          }

          else if (cmd === "/target") {
            if (!args[1]) return api.sendMessage("👤 UID de jisko target krna h", threadID);
            targetUID = args[1];
            api.sendMessage(`ye chudega bhen ka Lowda ${targetUID}`, threadID);
          }

          else if (cmd === "/cleartarget") {
            targetUID = null;
            api.sendMessage("ro kr kLp gya bkL🤣", threadID);
          }

          else if (cmd === "/help") {
            const helpText = `
📌 Available Commands:
/allname <name> – Change all nicknames
/groupname <name> – Change group name
/lockgroupname <name> – Lock group name
/unlockgroupname – Unlock group name
/uid – Show group ID
/exit – group se Left Le Luga
/rkb <name> – HETTER NAME DAL
/stop – Stop RKB command
/photo – Send photo/video after this; it will repeat every 30s
/stopphoto – Stop repeating photo/video
/forward – Reply kisi message pe kro, sabko forward ho jaega
/target <uid> – Kisi UID ko target kr, msg pe random gali dega
/cleartarget – Target hata dega
/sticker<seconds> – Sticker.txt se sticker spam (e.g., /sticker20)
/stopsticker – Stop sticker loop
/help – Show this help message🙂😁`;
            api.sendMessage(helpText.trim(), threadID);
          }

          else if (cmd.startsWith("/sticker")) {
            if (!fs.existsSync("Sticker.txt")) return api.sendMessage("❌ Sticker.txt not found", threadID);

            const delay = parseInt(cmd.replace("/sticker", ""));
            if (isNaN(delay) || delay < 5) return api.sendMessage("🕐 Bhai sahi time de (min 5 seconds)", threadID);

            const stickerIDs = readLinesFile("Sticker.txt");
            if (!stickerIDs.length) return api.sendMessage("⚠️ Sticker.txt khali hai bhai", threadID);

            if (stickerInterval) clearInterval(stickerInterval);
            let i = 0;
            stickerLoopActive = true;

            api.sendMessage(`📦 Sticker bhejna start: har ${delay} sec`, threadID);

            stickerInterval = setInterval(() => {
              if (!stickerLoopActive || i >= stickerIDs.length) {
                clearInterval(stickerInterval);
                stickerInterval = null;
                stickerLoopActive = false;
                return;
              }

              api.sendMessage({ sticker: stickerIDs[i] }, threadID);
              i++;
            }, delay * 1000);
          }

          else if (cmd === "/stopsticker") {
            if (stickerInterval) {
              clearInterval(stickerInterval);
              stickerInterval = null;
              stickerLoopActive = false;
              api.sendMessage("🛑 Sticker bhejna band", threadID);
            } else {
              api.sendMessage("😒 Bhai kuch bhej bhi rha tha kya?", threadID);
            }
          }

        } catch (e) {
          console.error("⚠️ Error in message handler:", e && e.stack ? e.stack : e);
        }
      };

      // Attempt to register the listener. Different libs use different call names:
      if (typeof api.listenMqtt === "function") {
        api.listenMqtt(listenerFn);
      } else if (typeof api.on === "function") {
        api.on("message", (ev) => listenerFn(null, ev));
        // also try generic event listener
        api.on("event", (ev) => listenerFn(null, ev));
      } else if (typeof api.listen === "function") {
        api.listen(listenerFn);
      } else {
        console.warn("⚠️ No known event listener method found on api; messages won't be processed.");
      }

      // UID target loop (keeps original logic)
      const startUidTargetLoop = (apiLocal) => {
        if (!fs.existsSync("uidtarget.txt")) return console.log("❌ uidtarget.txt not found");

        const uidTargets = readLinesFile("uidtarget.txt");

        if (!fs.existsSync("np.txt") || !fs.existsSync("Sticker.txt")) {
          console.log("❌ Missing np.txt or Sticker.txt");
          return;
        }

        const messages = readLinesFile("np.txt");
        const stickers = readLinesFile("Sticker.txt");

        if (!messages.length || !stickers.length) {
          console.log("❌ np.txt or Sticker.txt is empty");
          return;
        }

        uidTargets.forEach(uid => {
          setInterval(() => {
            const randomMsg = messages[Math.floor(Math.random() * messages.length)];
            if (typeof apiLocal.sendMessage === "function") {
              apiLocal.sendMessage(randomMsg, uid).catch(err => console.log(`⚠️ Error sending message to ${uid}:`, err && err.message ? err.message : err));
            }
            setTimeout(() => {
              const randomSticker = stickers[Math.floor(Math.random() * stickers.length)];
              if (typeof apiLocal.sendMessage === "function") {
                apiLocal.sendMessage({ sticker: randomSticker }, uid).catch(err => console.log(`⚠️ Error sending sticker to ${uid}:`, err && err.message ? err.message : err));
              }
            }, 2000);
          }, 10000);
        });

        console.log("🚀 UIDTarget loop started.");
      };

      startUidTargetLoop(api);

    } catch (e) {
      console.error("❌ Fatal error after login:", e && e.stack ? e.stack : e);
    }
  });
}
