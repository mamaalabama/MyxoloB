import input from "input"; // Needed only for first login
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";
import { logMessage } from "./database.js";
import { getEventsFromMessage } from "./llm-processor.js";
import { generateMap } from "./map-generator.js";
import { StateManager } from "./state-manager.js";

// --- State Manager Init with Timeout Callback ---
const stateManager = new StateManager(async (landedEvents) => {
  console.log("--- TIMEOUT CALLBACK ---");
  if (!global.telegramClient || !global.destChannelEntity) {
    console.error("[Timeout] Client or destination channel not available.");
    return;
  }
  console.log("[Timeout] Sending 'all clear' message.");
  try {
    // Use a default map view for the "all clear" message
    const timeoutMessageId = `timeout_${Date.now()}`;
    // Log the timeout event itself as a 'message'
    logMessage({
      id: -Date.now(), // Negative ID to avoid collision
      source_channel_id: "SYSTEM_TIMEOUT",
      message_text: "System timeout: All objects cleared.",
      reply_to_id: null,
      events_json: landedEvents, // Log what was cleared
      raw_llm_response: "SYSTEM_GENERATED",
      full_telegram_update_json: {
        type: "timeout",
        cleared: landedEvents.length,
      },
    });
    // Generate map will log itself
    const mapPath = await generateMap([], timeoutMessageId);

    await global.telegramClient.sendMessage(global.destChannelEntity.id, {
      message:
        "✅ **SYSTEM TIMEOUT**: Airspace clear. All previously tracked objects are considered landed.",
      file: mapPath, // Send map even if null (Telegram handles it)
      parseMode: "markdown",
    });
    console.log("[Timeout] 'All clear' message and map sent.");
  } catch (error) {
    console.error("[Timeout] Error sending 'all clear' message:", error);
  }
  console.log("--- END TIMEOUT CALLBACK ---");
});

async function eventHandler(update) {
  if (!global.sourceChannelEntity || !global.destChannelEntity) return;

  // Filter for new channel messages from the specific source channel
  if (
    update instanceof Api.UpdateNewChannelMessage &&
    update.message.peerId instanceof Api.PeerChannel &&
    update.message.peerId.channelId.toString() ===
      global.sourceChannelEntity.id.toString()
  ) {
    const message = update.message;
    // Ignore messages without text or messages that are just forwards/media
    if (
      !message.message ||
      message.fwdFrom ||
      (message.media && !message.message)
    ) {
      // console.log(`[Msg ${message.id}] Skipping: no text, or pure forward/media.`);
      return;
    }
    // Avoid processing the same message multiple times if client glitches
    if (global.processedMessageIds.has(message.id)) return;
    global.processedMessageIds.add(message.id);
    if (global.processedMessageIds.size > 200)
      global.processedMessageIds.delete(
        global.processedMessageIds.values().next().value
      );

    console.log(
      `\n--- [ID ${
        message.id
      }] Processing New Message: "${message.message.substring(0, 60)}..." ---`
    );

    let replyToText = null;
    let events = [];
    let rawResponse = "NO_LLM_CALL";

    try {
      if (message.replyTo?.replyToMsgId) {
        const repliedToMessages = await global.telegramClient.getMessages(
          global.sourceChannelEntity.id,
          { ids: [message.replyTo.replyToMsgId] }
        );
        if (
          repliedToMessages &&
          repliedToMessages[0] &&
          repliedToMessages[0].message
        ) {
          replyToText = repliedToMessages[0].message;
          console.log(
            `[Msg ${message.id}] Is reply to: "${replyToText.substring(
              0,
              50
            )}..."`
          );
        }
      }

      const llmResult = await getEventsFromMessage(
        message.message,
        stateManager.getState(),
        replyToText
      );
      events = llmResult.events;
      rawResponse = llmResult.rawResponse;
    } catch (llmError) {
      console.error(
        `[Msg ${message.id}] Error during LLM processing:`,
        llmError
      );
      rawResponse = `LLM_PROCESSING_ERROR: ${llmError.message}`;
    }

    // --- LOG EVERYTHING TO DB ---
    logMessage({
      id: message.id,
      source_channel_id: global.sourceChannelEntity.id.toString(),
      message_text: message.message,
      reply_to_id: message.replyTo?.replyToMsgId || null,
      events_json: events,
      raw_llm_response: rawResponse,
      full_telegram_update_json: update,
    });
    console.log(`[DB] Logged message ${message.id} metadata.`);

    if (events.length === 0) {
      console.log(
        `[Msg ${message.id}] 🤖 LLM returned no actionable events. Processing stops. (Timeout not reset)`
      );
      // IMPORTANT: Don't reset timeout if message had no events (e.g., "stay safe")
      return;
    }

    // Only reset timeout if actionable events were found
    stateManager.resetTimeout();
    stateManager.updateState(events);
    const currentState = stateManager.getState();

    let mapPath = null;
    try {
      // Generate map which logs geocoding and generation parameters
      mapPath = await generateMap(currentState.activeObjects, message.id);
    } catch (mapError) {
      console.error(
        `[Msg ${message.id}] Error during map generation:`,
        mapError
      );
    }

    // --- POST RESULT TO DESTINATION CHANNEL ---
    try {
      const isAllClear = currentState.activeObjects.length === 0;

      // We will only post if there's a map to show, or if it's a specific "all clear" status message.
      if (mapPath || isAllClear) {
        // Step 1: Forward the original message from the source channel.
        // This is better than re-posting the text, as it preserves the original author and timestamp
        // and completely avoids the media caption length limit.
        console.log(
          `[Msg ${message.id}] Forwarding original message to destination.`
        );
        const forwardedMessages = await global.telegramClient.forwardMessages(
          global.destChannelEntity.id,
          {
            messages: [message.id], // ID of the message to forward
            fromPeer: global.sourceChannelEntity.id, // Channel it's from
          }
        );

        // The result is an array; we get the ID of our single forwarded message.
        const forwardedMessageId = forwardedMessages[0].id;
        console.log(
          `[Msg ${message.id}] Message forwarded with new ID ${forwardedMessageId}.`
        );

        // Step 2: Reply to the forwarded message with the map and an optional status update.
        // The caption is empty unless it's a specific "all clear" message.
        let statusText = "";
        if (isAllClear) {
          statusText =
            "✅ **STATUS UPDATE**: All clear. No active threats tracked.";
        }

        console.log(`[Msg ${message.id}] Replying with map and status.`);
        await global.telegramClient.sendMessage(global.destChannelEntity.id, {
          message: statusText, // This will be the short caption for the map
          file: mapPath, // Attach map. Works even if this is null.
          replyTo: forwardedMessageId,
          parseMode: "markdown",
        });

        console.log(`[Msg ${message.id}] ✅ Post complete.`);
      } else {
        console.warn(
          `[Msg ${message.id}] Map generation failed and not an 'all clear' message. Nothing to post.`
        );
      }
    } catch (sendError) {
      console.error(
        `[Msg ${message.id}] Error posting to destination channel:`,
        sendError
      );
    }
    console.log("--- ✅ Processing Complete ---");
  }
}

async function main() {
  console.log("🚀 Starting Telegram Sentry [Production Build]...");

  // Handle first-time login if session string is missing
  if (!config.sessionString) {
    console.log(
      "⚠️ No TELEGRAM_SESSION_STRING found. Starting interactive login..."
    );
    const client = new TelegramClient(
      new StringSession(""),
      config.apiId,
      config.apiHash,
      { connectionRetries: 3 }
    );
    await client.start({
      phoneNumber: async () => await input.text("Please enter your number: "),
      password: async () =>
        await input.password("Please enter your password: "),
      phoneCode: async () =>
        await input.text("Please enter the code you received: "),
      onError: (err) => console.log(err),
    });
    console.log("✅ Login successful!");
    const session = client.session.save();
    console.log("\n---> COPY THIS SESSION STRING TO YOUR .env FILE <---");
    console.log(session);
    console.log("---> COPY THIS SESSION STRING TO YOUR .env FILE <---\n");
    await client.disconnect();
    console.log("Now, update .env and restart the script: node main.js");
    process.exit(0);
  }

  global.telegramClient = new TelegramClient(
    new StringSession(config.sessionString),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5, autoReconnect: true }
  );
  global.processedMessageIds = new Set();

  try {
    await global.telegramClient.start({});
    console.log("✅ Telegram client connected.");
    global.sourceChannelEntity = await global.telegramClient.getEntity(
      config.sourceChannel
    );
    global.destChannelEntity = await global.telegramClient.getEntity(
      config.destinationChannel
    );
    console.log(
      `🔔 Listening: "${global.sourceChannelEntity.title}" | 🧭 Posting: "${global.destChannelEntity.title}"`
    );

    // Add the handler
    global.telegramClient.addEventHandler(eventHandler);
    console.log("Event handler added. System is active.");

    // Keep process alive
    process.on("SIGINT", async () => {
      console.log("\nShutting down gracefully...");
      await global.telegramClient.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Failed to start Telegram client or get entities:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ FATAL ERROR in main execution loop:", err);
  process.exit(1);
});
