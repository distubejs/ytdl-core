
const { setTimeout } = require("timers");

class Cache extends Map {
  constructor(timeout = 1000) {
    super();
    this.timeout = timeout;
  }

  set(key, value) {
    const existingEntry = this.get(key);
    if (existingEntry) {
      clearTimeout(existingEntry.tid);
    }

    const tid = setTimeout(() => this.delete(key), this.timeout).unref();
    super.set(key, { tid, value });
  }

  get(key) {
    const entry = super.get(key);
    return entry ? entry.value : null;
  }

  async getOrSet(key, fn) {
    let value = this.get(key);

    if (value !== null) {
      return value;
    } 

    try {
      value = await fn(); // Evaluation of the provided function
      this.set(key, value); // Store the evaluated value
    } catch (err) {
      // Handle any errors from the provided function without storing the value
      console.error(`Error while setting value for key "${key}":`, err);
      return null;
    }

    return value;
  }
  
  delete(key) {
    const entry = super.get(key);
    if (entry) {
      clearTimeout(entry.tid);
      super.delete(key);
    }
  }

  clear() {
    for (const entry of this.values()) {
      clearTimeout(entry.tid);
    }
    super.clear();
  }
}

module.exports = Cache;
