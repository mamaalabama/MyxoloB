import { v4 as uuidv4 } from "uuid";
import { config } from "./config.js";
import { loadWorldState, saveWorldState } from "./database.js";

export class StateManager {
  constructor(onTimeoutCallback) {
    this.activeObjects = loadWorldState();
    console.log(
      `[State] Initial state loaded from DB with ${this.activeObjects.length} objects.`
    );
    this.timeoutId = null;
    this.timeoutDuration = config.stateResetTimeout;
    this.onTimeout = onTimeoutCallback;
    if (this.activeObjects.length > 0) {
      this.resetTimeout(); // Start timeout if state is not empty on load
    }
  }

  getState() {
    // Return a copy to prevent accidental mutation
    return { activeObjects: [...this.activeObjects] };
  }

  persistState() {
    try {
      saveWorldState(this.activeObjects);
    } catch (e) {
      console.error("[State] FATAL: Failed to save state to DB", e);
    }
  }

  clearStateAndNotify() {
    const landedEvents = this.activeObjects.map((obj) => ({
      event: "landed",
      details: { quantity: obj.quantity, item: obj.item, city: obj.to },
    }));
    this.activeObjects = [];
    this.persistState();
    if (landedEvents.length > 0 && typeof this.onTimeout === "function") {
      this.onTimeout(landedEvents); // Notify only if there were objects to clear
    }
  }

  resetTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    // Only set a timeout if there are active objects
    if (this.activeObjects.length === 0) {
      console.log("[State] No active objects, timeout timer not started.");
      return;
    }
    console.log(
      `[State] Activity detected. Resetting timeout timer for ${
        this.timeoutDuration / 60000
      } minutes.`
    );
    this.timeoutId = setTimeout(() => {
      console.log("[State] ⏳ Timeout reached. Clearing all active objects.");
      this.clearStateAndNotify();
      this.timeoutId = null; // Clear the ID after timeout
    }, this.timeoutDuration);
  }

  updateState(events) {
    if (!events || events.length === 0) {
      console.log("[State] No new events to process.");
      this.resetTimeout(); // Still reset timeout on activity
      return;
    }

    console.log("[State] Updating state with new events.");

    const shahedSummaryEvents = events.filter(
      (e) => e.event === "continue" && e.details.item === "shahed"
    );
    // Heuristic: if multiple 'continue' shahed events arrive, and they are the only events, treat as full summary
    const isFullShahedUpdate =
      shahedSummaryEvents.length > 1 &&
      events.length === shahedSummaryEvents.length;

    if (isFullShahedUpdate) {
      console.log(
        "[State] Detected full 'shahed' summary. Replacing all active shaheds."
      );
      const otherObjects = this.activeObjects.filter(
        (obj) => obj.item !== "shahed"
      );
      const newShahedObjects = shahedSummaryEvents.map((event) => ({
        id: uuidv4(),
        quantity: event.details.quantity || 1,
        item: event.details.item,
        from: event.details.from,
        to: event.details.to,
        direction: event.details.direction || null,
      }));
      this.activeObjects = [...otherObjects, ...newShahedObjects];
    } else {
      console.log("[State] Processing events incrementally.");
      events.forEach((event) => this.processEvent(event));
    }

    this.persistState();
    this.resetTimeout(); // Reset timeout after state update
  }

  processEvent(event) {
    if (!event || !event.details) return;
    const d = event.details;
    switch (event.event) {
      case "launch":
        this.addObject({
          quantity: d.quantity,
          item: d.item,
          from: d.from,
          to: d.to,
          direction: d.direction,
        });
        break;
      case "continue":
        // Attempt to update, if not found, add it.
        if (
          !this.updateObject({
            quantity: d.quantity,
            item: d.item,
            from: d.from,
            to: d.to,
            direction: d.direction,
          })
        ) {
          this.addObject({
            quantity: d.quantity,
            item: d.item,
            from: d.from,
            to: d.to,
            direction: d.direction,
          });
        }
        break;
      case "landed":
        this.removeObject({
          quantity: d.quantity,
          item: d.item,
          location: d.city || d.to || d.from,
        });
        break;
      case "alarm":
        this.addObject({
          quantity: d.quantity || 1,
          item: d.item,
          from: d.region,
          to: d.region,
        });
        break;
      default:
        console.warn(`[State] Unknown event type: ${event.event}`);
    }
  }

  addObject({ quantity, item, from, to, direction }) {
    if (!item || !from || !to) return;
    this.activeObjects.push({
      id: uuidv4(),
      quantity: quantity || 1,
      item,
      from,
      to,
      direction: direction || null,
    });
    console.log(
      `[State] Added: ${quantity || 1} ${item} from ${from} -> ${to}${
        direction ? ` (Direction: ${direction})` : ""
      }`
    );
  }

  updateObject({ quantity, item, from, to, direction }) {
    if (!item || !from || !to) return false;
    // Find object heading to the same destination to update
    const existingIndex = this.activeObjects.findIndex(
      (obj) => obj.item === item && obj.to === to
    );
    if (existingIndex > -1) {
      const target = this.activeObjects[existingIndex];
      console.log(
        `[State] Updated: ${item} ${target.to} (${target.quantity} -> ${
          quantity || 1
        })`
      );
      target.quantity = quantity || 1;
      target.from = from; // update origin
      target.direction = direction || null; // update direction
      return true;
    }
    return false; // Not found
  }

  removeObject({ quantity, item, location }) {
    if (!item || !location) return;
    // Find object either at the location ('to') or originating from it ('from')
    const targetIndex = this.activeObjects.findIndex(
      (obj) =>
        obj.item === item && (obj.to === location || obj.from === location)
    );
    if (targetIndex > -1) {
      const target = this.activeObjects[targetIndex];
      const removeQty = quantity || target.quantity; // remove all if quantity not specified
      target.quantity -= removeQty;
      console.log(
        `[State] Reduced: ${item} at ${location} by ${removeQty}. New count: ${target.quantity}`
      );
      if (target.quantity <= 0) {
        this.activeObjects.splice(targetIndex, 1);
        console.log(`[State] Removed group: ${item} at ${location}.`);
        if (this.activeObjects.length === 0) {
          console.log("[State] All objects removed.");
          if (this.timeoutId) {
            // All clear, stop the timeout timer
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
            console.log("[State] Timeout timer stopped.");
          }
        }
      }
    } else {
      console.warn(
        `[State] Could not find object to remove: ${item} at ${location}`
      );
    }
  }
}
