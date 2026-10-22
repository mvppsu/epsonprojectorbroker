"use strict";

// One-at-a-time gate shared by every protocol client that talks to the projector.
// Reports for older Epson models describe ESC/VP.net falling over when it is polled hard
// or polled at the same time as another protocol; on this LS11000 the ESC/VP.net service
// was seen to hang after being hit during shutdown while PJLink was also being polled.
// Routing PJLink and ESC/VP.net through one queue guarantees they never overlap.
class SerialBus {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const result = this.tail.then(() => task());
    // Keep the chain alive regardless of whether this task failed.
    this.tail = result.catch(() => {});
    return result;
  }
}

module.exports = { SerialBus };
